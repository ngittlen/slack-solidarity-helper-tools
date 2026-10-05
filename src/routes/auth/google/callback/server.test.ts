import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSessionSet = vi.hoisted(() => vi.fn());
const mockConfigured = vi.hoisted(() => ({ value: true }));
const mockRecord = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/google-volunteers', () => ({ recordGoogleSignIn: mockRecord }));

vi.mock('$lib/server/db', () => ({
	sessionStore: { set: mockSessionSet },
	db: {},
}));

vi.mock('$lib/server/env', () => ({
	SLACK_CLIENT_SECRET: 'client-secret',
	GOOGLE_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
	GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
	GOOGLE_REDIRECT_URI: 'http://localhost/auth/google/callback',
	googleSignInConfigured: () => mockConfigured.value,
}));

vi.mock('$app/environment', () => ({ dev: true }));

import { GET } from './+server.js';
import { signState, STATE_TTL_MS, type OAuthPurpose } from '$lib/server/oauth-state.js';

/** An unsigned id_token with these claims — the callback reads, not verifies. */
function idToken(overrides: Record<string, unknown> = {}): string {
	const claims = {
		iss: 'https://accounts.google.com',
		aud: 'client-id.apps.googleusercontent.com',
		exp: Math.floor(Date.now() / 1000) + 3600,
		sub: '1093',
		email: 'ana@example.com',
		email_verified: true,
		name: 'Ana Ruiz',
		...overrides,
	};
	const part = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
	return `${part({ alg: 'RS256' })}.${part(claims)}.sig`;
}

function mockTokenResponse(body: unknown, ok = true): ReturnType<typeof vi.fn> {
	const fetchMock = vi
		.fn()
		.mockResolvedValue({ ok, status: ok ? 200 : 400, json: async () => body });
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

interface EventOpts {
	rawState?: string;
	cookieState?: string;
	noStateCookie?: boolean;
	noPkceCookie?: boolean;
	stateDestination?: string | null;
	isRetry?: boolean;
	redirectTo?: string;
	purpose?: OAuthPurpose;
	googleError?: string;
}

function makeEvent(opts: EventOpts = {}) {
	const { state, nonce } = signState({
		destination: opts.stateDestination ?? null,
		isRetry: opts.isRetry ?? false,
		purpose: opts.purpose ?? 'google-login',
	});
	const jar: Record<string, string | undefined> = {
		google_oauth_state: opts.noStateCookie ? undefined : (opts.cookieState ?? nonce),
		google_pkce: opts.noPkceCookie ? undefined : 'VERIFIER',
		oauth_redirect: opts.redirectTo,
	};
	const url = new URL('http://localhost/auth/google/callback');
	if (opts.googleError) {
		url.searchParams.set('error', opts.googleError);
	} else {
		url.searchParams.set('code', 'CODE');
	}
	url.searchParams.set('state', opts.rawState ?? state);
	return {
		url,
		cookies: {
			get: vi.fn((name: string) => jar[name]),
			set: vi.fn(),
			delete: vi.fn(),
		},
	};
}

describe('GET /auth/google/callback', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockConfigured.value = true;
		mockRecord.mockResolvedValue(undefined);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('creates a turf-only Google session and lands on /turfs', async () => {
		const fetchMock = mockTokenResponse({ id_token: idToken() });
		const event = makeEvent();

		await expect(GET(event as never)).rejects.toMatchObject({ status: 302, location: '/turfs' });

		expect(mockSessionSet).toHaveBeenCalledTimes(1);
		expect(mockSessionSet.mock.calls[0]?.[1]).toEqual({
			slackUserId: 'google:1093',
			slackUserName: 'Ana Ruiz',
			isAdmin: false,
			isModerator: false,
			authProvider: 'google',
		});
		expect(mockSessionSet.mock.calls[0]?.[2]).toBe(8 * 60 * 60);
		expect(event.cookies.set).toHaveBeenCalledWith(
			'session',
			expect.any(String),
			expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
		);
		// The PKCE verifier from the cookie is what goes to Google.
		expect(
			Object.fromEntries(fetchMock.mock.calls[0]![1].body as URLSearchParams).code_verifier,
		).toBe('VERIFIER');
		// The flow's cookies are spent.
		for (const name of ['google_oauth_state', 'google_pkce', 'oauth_redirect']) {
			expect(event.cookies.delete).toHaveBeenCalledWith(name, { path: '/' });
		}
	});

	it('records who signed in, email included, for the organizers', async () => {
		mockTokenResponse({ id_token: idToken() });
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });
		expect(mockRecord).toHaveBeenCalledWith(expect.anything(), {
			userId: 'google:1093',
			email: 'ana@example.com',
			displayName: 'Ana Ruiz',
		});
	});

	it('still signs them in when the record cannot be written', async () => {
		mockRecord.mockRejectedValue(new Error('db down'));
		mockTokenResponse({ id_token: idToken() });
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/turfs',
		});
		expect(mockSessionSet).toHaveBeenCalledTimes(1);
	});

	it('records nothing for a refused sign-in', async () => {
		mockTokenResponse({ id_token: idToken({ email_verified: false }) });
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 403 });
		expect(mockRecord).not.toHaveBeenCalled();
	});

	it('returns to the /turfs page asked for, query string and all', async () => {
		mockTokenResponse({ id_token: idToken() });
		await expect(
			GET(makeEvent({ redirectTo: '/turfs?chapter=12' }) as never),
		).rejects.toMatchObject({ location: '/turfs?chapter=12' });
	});

	it('sends a Google sign-in that asked for any other page to /turfs', async () => {
		mockTokenResponse({ id_token: idToken() });
		await expect(GET(makeEvent({ redirectTo: '/settings' }) as never)).rejects.toMatchObject({
			location: '/turfs',
		});
	});

	it('names a volunteer with no profile name neutrally, never by their email', async () => {
		mockTokenResponse({ id_token: idToken({ name: undefined }) });
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });
		expect(mockSessionSet.mock.calls[0]?.[1].slackUserName).toBe('Google volunteer');
	});

	it('never logs the email', async () => {
		mockTokenResponse({ id_token: idToken() });
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });
		const logged = vi.mocked(console.log).mock.calls.flat().join(' ');
		expect(logged).toContain('google:1093');
		expect(logged).not.toContain('ana@example.com');
	});

	it('sends a Cancel back to the sign-in page', async () => {
		await expect(GET(makeEvent({ googleError: 'access_denied' }) as never)).rejects.toMatchObject({
			status: 302,
			location: '/signin?cancelled=1',
		});
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('keeps where they were going when they cancel', async () => {
		await expect(
			GET(makeEvent({ googleError: 'access_denied', redirectTo: '/members?user=U1' }) as never),
		).rejects.toMatchObject({
			location: '/signin?redirectTo=%2Fmembers%3Fuser%3DU1&cancelled=1',
		});
		// The cookie lost in a browser handoff: the signed state still knows.
		await expect(
			GET(
				makeEvent({ googleError: 'access_denied', stateDestination: '/turfs?chapter=3' }) as never,
			),
		).rejects.toMatchObject({
			location: '/signin?redirectTo=%2Fturfs%3Fchapter%3D3&cancelled=1',
		});
	});

	it('drops an unsafe destination on the way back', async () => {
		await expect(
			GET(makeEvent({ googleError: 'access_denied', redirectTo: '//evil.example' }) as never),
		).rejects.toMatchObject({ location: '/signin?cancelled=1' });
	});

	it('refuses an unverified email with 403 and no session', async () => {
		mockTokenResponse({ id_token: idToken({ email_verified: false }) });
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 403 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('answers 502 when the exchange fails', async () => {
		mockTokenResponse({ error: 'invalid_grant' }, false);
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 502 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('answers 502 for a token minted for another client', async () => {
		mockTokenResponse({ id_token: idToken({ aud: 'someone-else' }) });
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 502 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('400s a tampered state without calling Google', async () => {
		const fetchMock = mockTokenResponse({ id_token: idToken() });
		const { state } = signState({ destination: null, isRetry: false, purpose: 'google-login' });
		await expect(
			GET(makeEvent({ rawState: `${state.slice(0, -2)}xx` }) as never),
		).rejects.toMatchObject({ status: 400 });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('400s a Slack state, whatever else is right about it', async () => {
		const fetchMock = mockTokenResponse({ id_token: idToken() });
		await expect(GET(makeEvent({ purpose: 'login' }) as never)).rejects.toMatchObject({
			status: 400,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('400s a state cookie that does not match', async () => {
		const fetchMock = mockTokenResponse({ id_token: idToken() });
		await expect(GET(makeEvent({ cookieState: 'other' }) as never)).rejects.toMatchObject({
			status: 400,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('restarts once, keeping the destination, when the cookies did not come back', async () => {
		await expect(
			GET(makeEvent({ noStateCookie: true, stateDestination: '/turfs?chapter=3' }) as never),
		).rejects.toMatchObject({
			status: 302,
			location: '/auth/google?redirectTo=%2Fturfs%3Fchapter%3D3&retry=1',
		});
		await expect(GET(makeEvent({ noPkceCookie: true }) as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/google?retry=1',
		});
	});

	it('gives up with an explanation when the cookies are still missing on the retry', async () => {
		await expect(
			GET(makeEvent({ noStateCookie: true, isRetry: true }) as never),
		).rejects.toMatchObject({ status: 400, body: { message: expect.stringContaining('cookie') } });
	});

	it('restarts an expired state, keeping its destination', async () => {
		vi.useFakeTimers();
		try {
			const event = makeEvent({ stateDestination: '/turfs' });
			vi.advanceTimersByTime(STATE_TTL_MS + 1000);
			await expect(GET(event as never)).rejects.toMatchObject({
				status: 302,
				location: '/auth/google?redirectTo=%2Fturfs&retry=1',
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('restarts a malformed state from scratch', async () => {
		await expect(GET(makeEvent({ rawState: 'not-a-state' }) as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/google?retry=1',
		});
	});

	it('404s when Google sign-in is not configured', async () => {
		mockConfigured.value = false;
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 404 });
	});
});

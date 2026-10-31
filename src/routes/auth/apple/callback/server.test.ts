import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSessionSet = vi.hoisted(() => vi.fn());
const mockConfigured = vi.hoisted(() => ({ value: true }));
const mockRecord = vi.hoisted(() => vi.fn());
const mockExchange = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/outside-volunteers', () => ({ recordOutsideSignIn: mockRecord }));

vi.mock('$lib/server/db', () => ({
	sessionStore: { set: mockSessionSet },
	db: {},
}));

vi.mock('$lib/server/env', () => ({
	SLACK_CLIENT_SECRET: 'client-secret',
	APPLE_SIGNIN_SERVICES_ID: 'org.example.turfs',
	APPLE_REDIRECT_URI: 'https://app.example/auth/apple/callback',
	appleSignInConfigured: () => mockConfigured.value,
}));

// The exchange itself (and its client-secret JWT) is tested in
// apple-signin.test.ts; here it only needs to hand back a token.
vi.mock('$lib/server/apple-signin', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/apple-signin.js')>()),
	exchangeAppleCode: mockExchange,
}));

vi.mock('$app/environment', () => ({ dev: true }));

import { POST } from './+server.js';
import { signState, STATE_TTL_MS, type OAuthPurpose } from '$lib/server/oauth-state.js';

const SUB = '001234.abcdef.0987';

/** An unsigned id_token with these claims — the callback reads, not verifies. */
function idToken(overrides: Record<string, unknown> = {}): string {
	const claims = {
		iss: 'https://appleid.apple.com',
		aud: 'org.example.turfs',
		exp: Math.floor(Date.now() / 1000) + 600,
		sub: SUB,
		email: 'x1y2@privaterelay.appleid.com',
		email_verified: 'true',
		is_private_email: 'true',
		nonce: 'TOKEN-NONCE',
		...overrides,
	};
	const part = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
	return `${part({ alg: 'RS256' })}.${part(claims)}.sig`;
}

const FIRST_USER = JSON.stringify({
	name: { firstName: 'Ana', lastName: 'Ruiz' },
	email: 'x1y2@privaterelay.appleid.com',
});

interface EventOpts {
	rawState?: string;
	cookieState?: string;
	noStateCookie?: boolean;
	noNonceCookie?: boolean;
	stateDestination?: string | null;
	isRetry?: boolean;
	redirectTo?: string;
	purpose?: OAuthPurpose;
	appleError?: string;
	user?: string;
}

function makeEvent(opts: EventOpts = {}) {
	const { state, nonce } = signState({
		destination: opts.stateDestination ?? null,
		isRetry: opts.isRetry ?? false,
		purpose: opts.purpose ?? 'apple-login',
	});
	const jar: Record<string, string | undefined> = {
		apple_oauth_state: opts.noStateCookie ? undefined : (opts.cookieState ?? nonce),
		apple_nonce: opts.noNonceCookie ? undefined : 'TOKEN-NONCE',
		oauth_redirect: opts.redirectTo,
	};
	const body = new URLSearchParams();
	if (opts.appleError) {
		body.set('error', opts.appleError);
	} else {
		body.set('code', 'CODE');
	}
	body.set('state', opts.rawState ?? state);
	// What Apple posts alongside, and the callback must ignore: anyone can.
	body.set('id_token', idToken({ sub: 'forged' }));
	if (opts.user !== undefined) body.set('user', opts.user);
	return {
		request: new Request('https://app.example/auth/apple/callback', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body,
		}),
		cookies: {
			get: vi.fn((name: string) => jar[name]),
			set: vi.fn(),
			delete: vi.fn(),
		},
	};
}

describe('POST /auth/apple/callback', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockConfigured.value = true;
		mockExchange.mockResolvedValue(idToken());
		// Stores and returns the name it was offered, as on a first sign-in.
		mockRecord.mockImplementation(async (_db, v: { displayName: string | null }) => v.displayName);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('creates a turf-only Apple session from a first sign-in and lands on /turfs', async () => {
		const event = makeEvent({ user: FIRST_USER });

		await expect(POST(event as never)).rejects.toMatchObject({ status: 303, location: '/turfs' });

		expect(mockExchange).toHaveBeenCalledWith('CODE');
		expect(mockSessionSet).toHaveBeenCalledTimes(1);
		expect(mockSessionSet.mock.calls[0]?.[1]).toEqual({
			slackUserId: `apple:${SUB}`,
			slackUserName: 'Ana Ruiz',
			isAdmin: false,
			isModerator: false,
			authProvider: 'apple',
		});
		expect(mockSessionSet.mock.calls[0]?.[2]).toBe(8 * 60 * 60);
		// The flow's cookies are spent.
		for (const name of ['apple_oauth_state', 'apple_nonce', 'oauth_redirect']) {
			expect(event.cookies.delete).toHaveBeenCalledWith(name, { path: '/' });
		}
	});

	it('records who signed in, relay address included, for the organizers', async () => {
		await expect(POST(makeEvent({ user: FIRST_USER }) as never)).rejects.toMatchObject({
			status: 303,
		});
		expect(mockRecord).toHaveBeenCalledWith(expect.anything(), {
			userId: `apple:${SUB}`,
			provider: 'apple',
			email: 'x1y2@privaterelay.appleid.com',
			isPrivateEmail: true,
			displayName: 'Ana Ruiz',
		});
	});

	it('uses the token from the exchange, never the one in the form post', async () => {
		await expect(POST(makeEvent() as never)).rejects.toMatchObject({ status: 303 });
		expect(mockSessionSet.mock.calls[0]?.[1].slackUserId).toBe(`apple:${SUB}`);
	});

	it('uses the stored name on a returning sign-in, which carries none', async () => {
		mockRecord.mockResolvedValue('Ana Ruiz');
		await expect(POST(makeEvent() as never)).rejects.toMatchObject({ status: 303 });
		expect(mockRecord.mock.calls[0]?.[1].displayName).toBeNull();
		const session = mockSessionSet.mock.calls[0]?.[1];
		expect(session.slackUserName).toBe('Ana Ruiz');
		expect(session.needsName).toBeUndefined();
	});

	it('asks for a name when Apple sent none and none is stored', async () => {
		await expect(POST(makeEvent() as never)).rejects.toMatchObject({ status: 303 });
		const session = mockSessionSet.mock.calls[0]?.[1];
		expect(session.needsName).toBe(true);
		// Spec 013's placeholder, for older code that knows nothing of needsName.
		expect(session.slackUserName).toBe('Apple volunteer');
	});

	it('tidies the name Apple sent', async () => {
		const user = JSON.stringify({ name: { firstName: '*Ana*', lastName: 'evil.com' } });
		await expect(POST(makeEvent({ user }) as never)).rejects.toMatchObject({ status: 303 });
		expect(mockSessionSet.mock.calls[0]?.[1].slackUserName).toBe('Ana evil·com');
	});

	it('still signs them in when the record cannot be written', async () => {
		mockRecord.mockRejectedValue(new Error('db down'));
		await expect(POST(makeEvent({ user: FIRST_USER }) as never)).rejects.toMatchObject({
			status: 303,
			location: '/turfs',
		});
		expect(mockSessionSet.mock.calls[0]?.[1].slackUserName).toBe('Ana Ruiz');
	});

	it('returns to the /turfs page asked for, and sends any other page to /turfs', async () => {
		await expect(
			POST(makeEvent({ redirectTo: '/turfs?chapter=12' }) as never),
		).rejects.toMatchObject({ location: '/turfs?chapter=12' });
		await expect(POST(makeEvent({ redirectTo: '/settings' }) as never)).rejects.toMatchObject({
			location: '/turfs',
		});
	});

	it('never logs the email', async () => {
		await expect(POST(makeEvent({ user: FIRST_USER }) as never)).rejects.toMatchObject({
			status: 303,
		});
		const logged = vi.mocked(console.log).mock.calls.flat().join(' ');
		expect(logged).toContain(`apple:${SUB}`);
		expect(logged).not.toContain('privaterelay');
	});

	it('sends a Cancel back to the sign-in page, naming Apple', async () => {
		await expect(
			POST(makeEvent({ appleError: 'user_cancelled_authorize' }) as never),
		).rejects.toMatchObject({ status: 303, location: '/signin?cancelled=apple' });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('keeps where they were going when they cancel', async () => {
		await expect(
			POST(
				makeEvent({
					appleError: 'user_cancelled_authorize',
					stateDestination: '/turfs?chapter=3',
				}) as never,
			),
		).rejects.toMatchObject({
			location: '/signin?redirectTo=%2Fturfs%3Fchapter%3D3&cancelled=apple',
		});
	});

	it('clears the flow cookies on a genuine cancel', async () => {
		const event = makeEvent({ appleError: 'user_cancelled_authorize' });
		await expect(POST(event as never)).rejects.toMatchObject({ status: 303 });
		for (const name of ['apple_oauth_state', 'apple_nonce', 'oauth_redirect']) {
			expect(event.cookies.delete).toHaveBeenCalledWith(name, { path: '/' });
		}
	});

	// Any site can post here (the CSRF exemption): a forged cancel must not
	// wipe a sign-in in progress, nor the destination the other flows share.
	it('leaves the cookies alone on a cancel that is not this browser’s login', async () => {
		for (const opts of [
			{ appleError: 'x', rawState: 'not-a-state', redirectTo: '/turfs?chapter=3' },
			{ appleError: 'x', cookieState: 'other', redirectTo: '/turfs?chapter=3' },
			{ appleError: 'x', purpose: 'google-login' as const, redirectTo: '/turfs?chapter=3' },
		]) {
			const event = makeEvent(opts);
			await expect(POST(event as never)).rejects.toMatchObject({
				status: 303,
				location: '/signin?cancelled=apple',
			});
			expect(event.cookies.delete).not.toHaveBeenCalled();
		}
	});

	it('refuses an unverified email with 403 and no session', async () => {
		mockExchange.mockResolvedValue(idToken({ email_verified: 'false' }));
		await expect(POST(makeEvent() as never)).rejects.toMatchObject({ status: 403 });
		expect(mockSessionSet).not.toHaveBeenCalled();
		expect(mockRecord).not.toHaveBeenCalled();
	});

	// School-managed Apple IDs, among others: told why, and nothing stored.
	it('refuses an Apple ID with no email with 403 and an explanation', async () => {
		mockExchange.mockResolvedValue(idToken({ email: undefined, email_verified: undefined }));
		await expect(POST(makeEvent() as never)).rejects.toMatchObject({
			status: 403,
			body: { message: expect.stringContaining('didn’t share an email address') },
		});
		expect(mockSessionSet).not.toHaveBeenCalled();
		expect(mockRecord).not.toHaveBeenCalled();
	});

	it('answers 502 when the exchange fails', async () => {
		mockExchange.mockResolvedValue(null);
		await expect(POST(makeEvent() as never)).rejects.toMatchObject({ status: 502 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('answers 502 for a token minted for another login attempt', async () => {
		mockExchange.mockResolvedValue(idToken({ nonce: 'SOMEONE-ELSES' }));
		await expect(POST(makeEvent() as never)).rejects.toMatchObject({ status: 502 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('answers 502 for a token minted for another client', async () => {
		mockExchange.mockResolvedValue(idToken({ aud: 'org.someone.else' }));
		await expect(POST(makeEvent() as never)).rejects.toMatchObject({ status: 502 });
	});

	it('400s a tampered state without calling Apple', async () => {
		const { state } = signState({ destination: null, isRetry: false, purpose: 'apple-login' });
		await expect(
			POST(makeEvent({ rawState: `${state.slice(0, -2)}xx` }) as never),
		).rejects.toMatchObject({ status: 400 });
		expect(mockExchange).not.toHaveBeenCalled();
	});

	it('400s a Slack or Google state, whatever else is right about it', async () => {
		for (const purpose of ['login', 'google-login'] as const) {
			await expect(POST(makeEvent({ purpose }) as never)).rejects.toMatchObject({ status: 400 });
		}
		expect(mockExchange).not.toHaveBeenCalled();
	});

	it('400s a state cookie that does not match', async () => {
		await expect(POST(makeEvent({ cookieState: 'other' }) as never)).rejects.toMatchObject({
			status: 400,
		});
		expect(mockExchange).not.toHaveBeenCalled();
	});

	it('restarts once, keeping the destination, when the cookies did not come back', async () => {
		await expect(
			POST(makeEvent({ noStateCookie: true, stateDestination: '/turfs?chapter=3' }) as never),
		).rejects.toMatchObject({
			status: 303,
			location: '/auth/apple?redirectTo=%2Fturfs%3Fchapter%3D3&retry=1',
		});
		await expect(POST(makeEvent({ noNonceCookie: true }) as never)).rejects.toMatchObject({
			status: 303,
			location: '/auth/apple?retry=1',
		});
	});

	it('gives up with an explanation when the cookies are still missing on the retry', async () => {
		await expect(
			POST(makeEvent({ noStateCookie: true, isRetry: true }) as never),
		).rejects.toMatchObject({ status: 400, body: { message: expect.stringContaining('cookie') } });
	});

	it('restarts an expired state, keeping its destination', async () => {
		vi.useFakeTimers();
		try {
			const event = makeEvent({ stateDestination: '/turfs' });
			vi.advanceTimersByTime(STATE_TTL_MS + 1000);
			await expect(POST(event as never)).rejects.toMatchObject({
				status: 303,
				location: '/auth/apple?redirectTo=%2Fturfs&retry=1',
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('restarts a malformed state from scratch', async () => {
		await expect(POST(makeEvent({ rawState: 'not-a-state' }) as never)).rejects.toMatchObject({
			status: 303,
			location: '/auth/apple?retry=1',
		});
	});

	it('400s a post with no code or state', async () => {
		const event = makeEvent();
		event.request = new Request('https://app.example/auth/apple/callback', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: '',
		});
		await expect(POST(event as never)).rejects.toMatchObject({ status: 400 });
	});

	it('404s when Apple sign-in is not configured', async () => {
		mockConfigured.value = false;
		await expect(POST(makeEvent() as never)).rejects.toMatchObject({ status: 404 });
	});
});

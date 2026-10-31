import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSessionSet = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockUsersInfo = vi.hoisted(() => vi.fn());
const mockSaveUserToken = vi.hoisted(() => vi.fn());
const mockDeleteUserToken = vi.hoisted(() => vi.fn());
const mockLoadUserToken = vi.hoisted(() => vi.fn());
const mockRevokeUserToken = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({
	sessionStore: { set: mockSessionSet },
	db: {},
}));

vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));

vi.mock('$lib/server/slack', () => ({ slack: { users: { info: mockUsersInfo } } }));

vi.mock('$lib/server/user-tokens', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/user-tokens')>();
	return {
		hasScope: real.hasScope,
		POST_AS_USER_SCOPE: real.POST_AS_USER_SCOPE,
		saveUserToken: mockSaveUserToken,
		deleteUserToken: mockDeleteUserToken,
		loadUserToken: mockLoadUserToken,
		revokeUserToken: mockRevokeUserToken,
	};
});

vi.mock('$lib/server/env', () => ({
	SLACK_CLIENT_ID: 'client-id',
	SLACK_CLIENT_SECRET: 'client-secret',
	SLACK_SUPERUSER_ID: 'USUPER',
	REDIRECT_URI: 'http://localhost/auth/slack/callback',
}));

vi.mock('$app/environment', () => ({ dev: true }));

import { GET } from './+server.js';
import {
	signState,
	verifyState,
	STATE_TTL_MS,
	type OAuthPurpose,
} from '$lib/server/oauth-state.js';

function jsonRes(body: unknown): Response {
	return { json: async () => body } as never;
}

interface EventOpts {
	code?: string;
	/** Overrides the signed state entirely — for tampered/legacy state tests. */
	rawState?: string;
	/** Overrides the nonce the cookie holds; defaults to the one just signed. */
	cookieState?: string;
	/** Drops the state cookie, as a browser handoff does. */
	noStateCookie?: boolean;
	/** Destination baked into the *signed* state. */
	stateDestination?: string | null;
	/** Marks the attempt as the one automatic retry. */
	isRetry?: boolean;
	/** Destination in the oauth_redirect *cookie*. */
	redirectTo?: string;
	/** Which flow the signed state belongs to; defaults to login. */
	purpose?: OAuthPurpose;
	/** The session already in place — the post-as-you grant needs one. */
	session?: App.Locals['session'];
	/** Slack's `?error=` — set when someone presses Cancel. */
	slackError?: string;
}

function makeEvent(opts: EventOpts = {}) {
	const code = opts.code ?? 'CODE';
	const { state, nonce } = signState({
		destination: opts.stateDestination ?? null,
		isRetry: opts.isRetry ?? false,
		purpose: opts.purpose,
	});
	const jar: Record<string, string | undefined> = {
		oauth_state: opts.noStateCookie ? undefined : (opts.cookieState ?? nonce),
		oauth_redirect: opts.redirectTo,
	};
	const url = new URL('http://localhost/auth/slack/callback');
	url.searchParams.set('code', code);
	url.searchParams.set('state', opts.rawState ?? state);
	if (opts.slackError) {
		url.searchParams.delete('code');
		url.searchParams.set('error', opts.slackError);
	}
	return {
		url,
		locals: { session: opts.session ?? null },
		cookies: {
			get: vi.fn((name: string) => jar[name]),
			set: vi.fn(),
			delete: vi.fn(),
		},
	};
}

const SETTINGS = {
	allowedSlackUserIds: new Set(['UADMIN']),
	moderatorSlackUserIds: new Set(['UMOD']),
};

function mockSuccessfulOAuth(userId: string, userName: string, scope = 'chat:write'): void {
	// A single call — the user id comes off the token response itself, so there
	// is no users.identity round trip to stub.
	vi.stubGlobal(
		'fetch',
		vi
			.fn()
			.mockResolvedValue(
				jsonRes({ ok: true, authed_user: { id: userId, access_token: 'tok', scope } }),
			),
	);
	mockUsersInfo.mockResolvedValue({ ok: true, user: { name: userName } });
}

describe('GET /auth/slack/callback', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue(SETTINGS);
		mockSaveUserToken.mockResolvedValue(undefined);
		mockDeleteUserToken.mockResolvedValue(undefined);
		mockUsersInfo.mockResolvedValue({ ok: true, user: { name: 'Someone' } });
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		vi.unstubAllGlobals();
	});

	it('admin path: creates session with isAdmin: true and redirects to /', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});

		expect(mockSessionSet).toHaveBeenCalledTimes(1);
		expect(mockSessionSet.mock.calls[0]?.[1]).toEqual({
			slackUserId: 'UADMIN',
			slackUserName: 'Admin User',
			isAdmin: true,
			isModerator: false,
		});
	});

	it('non-admin path: creates session with isAdmin: false and redirects to /', async () => {
		mockSuccessfulOAuth('UNORMAL', 'Bob');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});

		expect(mockSessionSet).toHaveBeenCalledTimes(1);
		expect(mockSessionSet.mock.calls[0]?.[1]).toEqual({
			slackUserId: 'UNORMAL',
			slackUserName: 'Bob',
			isAdmin: false,
			isModerator: false,
		});
	});

	it('superuser is admin even when absent from the allowed list', async () => {
		mockSuccessfulOAuth('USUPER', 'Root');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});

		expect(mockSessionSet.mock.calls[0]?.[1]).toEqual({
			slackUserId: 'USUPER',
			slackUserName: 'Root',
			isAdmin: true,
			isModerator: false,
		});
	});

	it('superuser is admin even when loadSettings rejects (lockout escape hatch)', async () => {
		mockLoadSettings.mockRejectedValue(new Error('db down'));
		mockSuccessfulOAuth('USUPER', 'Root');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});

		expect(mockSessionSet.mock.calls[0]?.[1]).toMatchObject({ isAdmin: true });
	});

	it('non-superuser is denied admin (not 500) when loadSettings rejects', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		mockLoadSettings.mockRejectedValue(new Error('db down'));
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});

		expect(mockSessionSet.mock.calls[0]?.[1]).toMatchObject({ isAdmin: false });
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining('[auth] loadSettings failed'),
			expect.anything(),
		);
		// "Not an admin" here means "couldn't tell", so a real admin's grant
		// must not be cleared over a database hiccup.
		expect(mockDeleteUserToken).not.toHaveBeenCalled();
		expect(mockRevokeUserToken).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it('moderator path: isModerator true, isAdmin false', async () => {
		mockSuccessfulOAuth('UMOD', 'Mo');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302, location: '/' });

		expect(mockSessionSet.mock.calls[0]?.[1]).toEqual({
			slackUserId: 'UMOD',
			slackUserName: 'Mo',
			isAdmin: false,
			isModerator: true,
		});
	});

	// isModerator means "moderator and nothing more"; an admin never carries it.
	it('someone on both lists is an admin, not a moderator', async () => {
		mockLoadSettings.mockResolvedValue({
			allowedSlackUserIds: new Set(['UBOTH']),
			moderatorSlackUserIds: new Set(['UBOTH']),
		});
		mockSuccessfulOAuth('UBOTH', 'Both');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSessionSet.mock.calls[0]?.[1]).toMatchObject({ isAdmin: true, isModerator: false });
	});

	it('sends a moderator back to the member page they asked for', async () => {
		mockSuccessfulOAuth('UMOD', 'Mo');

		await expect(
			GET(makeEvent({ redirectTo: '/members?user=U123' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/members?user=U123' });
	});

	it('does not send a moderator to an admin page', async () => {
		mockSuccessfulOAuth('UMOD', 'Mo');

		await expect(GET(makeEvent({ redirectTo: '/settings' }) as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});
	});

	it('admin gate reads the settings allowed list (DB-backed with env fallback)', async () => {
		mockLoadSettings.mockResolvedValue({
			allowedSlackUserIds: new Set(['UFROMDB']),
			moderatorSlackUserIds: new Set(),
		});
		mockSuccessfulOAuth('UFROMDB', 'Dana');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSessionSet.mock.calls[0]?.[1]).toMatchObject({ isAdmin: true });
	});

	it('does not log [auth] blocked user warning for legitimate non-admin sign-in', async () => {
		mockSuccessfulOAuth('UNORMAL', 'Bob');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		const blockedUserCalls = warnSpy.mock.calls.filter((args: unknown[]) =>
			args.some((arg) => typeof arg === 'string' && arg.includes('blocked user')),
		);
		expect(blockedUserCalls).toEqual([]);
	});

	it('logs successful login with admin status', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringMatching(/\[auth] login: Admin User \(UADMIN\) admin=true/),
		);
	});

	it('returns an admin to the page they originally requested', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(
			GET(makeEvent({ redirectTo: '/members?user=U123' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/members?user=U123' });
	});

	it('sends a non-admin who requested an admin page to /', async () => {
		mockSuccessfulOAuth('UNORMAL', 'Bob');

		await expect(GET(makeEvent({ redirectTo: '/settings' }) as never)).rejects.toMatchObject({
			status: 302,
			location: '/',
		});
	});

	it('ignores an off-site redirect cookie', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(
			GET(makeEvent({ redirectTo: '//evil.example/steal' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/' });
	});

	it('clears the redirect cookie once it has been consumed', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');
		const event = makeEvent({ redirectTo: '/settings' });

		await expect(GET(event as never)).rejects.toMatchObject({ status: 302 });

		expect(event.cookies.delete).toHaveBeenCalledWith('oauth_redirect', { path: '/' });
	});

	it('rejects with 400 on OAuth state mismatch (preserved behavior)', async () => {
		await expect(
			GET(makeEvent({ cookieState: 'a-different-nonce' }) as never),
		).rejects.toMatchObject({ status: 400 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	// Signed by us, but for the Google or Apple round trip — fresh or expired,
	// it is refused rather than exchanged or restarted as a Slack login.
	it.each(['google-login', 'apple-login'] as const)(
		'rejects a %s state with 400 and never calls Slack',
		async (purpose) => {
			const fetchMock = vi.fn();
			vi.stubGlobal('fetch', fetchMock);

			await expect(GET(makeEvent({ purpose }) as never)).rejects.toMatchObject({ status: 400 });

			vi.useFakeTimers();
			try {
				const stale = makeEvent({ purpose });
				vi.advanceTimersByTime(STATE_TTL_MS + 1000);
				await expect(GET(stale as never)).rejects.toMatchObject({ status: 400 });
			} finally {
				vi.useRealTimers();
			}
			expect(fetchMock).not.toHaveBeenCalled();
			expect(mockSessionSet).not.toHaveBeenCalled();
		},
	);

	it('rejects with 502 when Slack token exchange fails (preserved behavior)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(jsonRes({ ok: false, error: 'invalid_code' })),
		);

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 502 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});
});

// Login never keeps a token: it asks for users:read only. What it does do
// is clear a stored post-as-you token for anyone no longer an admin or
// moderator.
describe('GET /auth/slack/callback — login and stored tokens', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue(SETTINGS);
		mockSaveUserToken.mockResolvedValue(undefined);
		mockDeleteUserToken.mockResolvedValue(undefined);
		mockRevokeUserToken.mockResolvedValue(true);
		mockUsersInfo.mockResolvedValue({ ok: true, user: { name: 'Someone' } });
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		vi.unstubAllGlobals();
	});

	it("does not store an admin's login token, nor drop their post-as-you one", async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User', 'users:read');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSaveUserToken).not.toHaveBeenCalled();
		expect(mockDeleteUserToken).not.toHaveBeenCalled();
	});

	it("leaves a moderator's post-as-you token alone too", async () => {
		mockSuccessfulOAuth('UMOD', 'Mo', 'users:read');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSaveUserToken).not.toHaveBeenCalled();
		expect(mockDeleteUserToken).not.toHaveBeenCalled();
	});

	it('clears any stored token for a non-admin instead of keeping it', async () => {
		// Holding a credential the app has no use for is the thing to avoid —
		// this also cleans up after someone is dropped from the allowlist.
		mockSuccessfulOAuth('URANDOM', 'Random User', 'users:read');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSaveUserToken).not.toHaveBeenCalled();
		expect(mockDeleteUserToken).toHaveBeenCalledWith(expect.anything(), 'URANDOM');
	});

	// Revoking at every sign-in could show members Slack's Allow screen every
	// time, so a login only ever cleans up on our side.
	it('never revokes anyone at Slack on login', async () => {
		mockSuccessfulOAuth('URANDOM', 'Random User', 'users:read');
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });
		mockSuccessfulOAuth('UADMIN', 'Admin User', 'users:read');
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });
		mockSuccessfulOAuth('UMOD', 'Mo', 'users:read');
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockRevokeUserToken).not.toHaveBeenCalled();
	});

	it('still logs someone in when clearing their token fails', async () => {
		mockDeleteUserToken.mockRejectedValue(new Error('db down'));
		mockSuccessfulOAuth('URANDOM', 'Random User', 'users:read');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSessionSet).toHaveBeenCalledTimes(1);
	});

	it('still rejects a token response with no user id', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonRes({ ok: true, authed_user: { access_token: 'tok' } })),
		);

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 502 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});
});

// The opt-in grant behind /post-as-you: chat:write, so the info commands can
// post as the admin or moderator who runs them (see user-tokens.ts).
describe('GET /auth/slack/callback — post-as-you grant', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	const ADMIN_SESSION = {
		slackUserId: 'UADMIN',
		slackUserName: 'Admin User',
		isAdmin: true,
		isModerator: false,
	};

	function grantEvent(opts: EventOpts = {}) {
		return makeEvent({ purpose: 'post-as-you', session: ADMIN_SESSION, ...opts });
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue(SETTINGS);
		mockSaveUserToken.mockResolvedValue(undefined);
		mockDeleteUserToken.mockResolvedValue(undefined);
		mockRevokeUserToken.mockResolvedValue(true);
		// Nothing stored yet, unless a test says otherwise.
		mockLoadUserToken.mockResolvedValue({ ok: false, reason: 'missing' });
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
		vi.unstubAllGlobals();
	});

	it("stores an admin's chat:write token and lands on /post-as-you", async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(GET(grantEvent() as never)).rejects.toMatchObject({
			status: 302,
			location: '/post-as-you?enabled=1',
		});

		expect(mockSaveUserToken).toHaveBeenCalledWith(expect.anything(), {
			slackUserId: 'UADMIN',
			accessToken: 'tok',
			scopes: 'chat:write',
		});
		expect(mockRevokeUserToken).not.toHaveBeenCalled();
	});

	// Slack user tokens accumulate scopes, so a grant after a login comes back
	// carrying users:read as well.
	it('stores a token whose scopes accumulated from an earlier login', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User', 'users:read,chat:write');

		await expect(GET(grantEvent() as never)).rejects.toMatchObject({
			location: '/post-as-you?enabled=1',
		});

		expect(mockSaveUserToken).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ scopes: 'users:read,chat:write' }),
		);
	});

	it('does not create a new session — the grant rides on the existing one', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(GET(grantEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it("stores a moderator's token too", async () => {
		mockSuccessfulOAuth('UMOD', 'Mo');
		const session = { slackUserId: 'UMOD', slackUserName: 'Mo', isAdmin: false, isModerator: true };

		await expect(GET(grantEvent({ session }) as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSaveUserToken).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ slackUserId: 'UMOD' }),
		);
	});

	it("stores the superuser's even while the lists can't be read", async () => {
		mockLoadSettings.mockRejectedValue(new Error('db down'));
		mockSuccessfulOAuth('USUPER', 'Root');
		const session = { slackUserId: 'USUPER', slackUserName: 'Root', isAdmin: true };

		await expect(GET(grantEvent({ session }) as never)).rejects.toMatchObject({
			location: '/post-as-you?enabled=1',
		});

		expect(mockSaveUserToken).toHaveBeenCalled();
	});

	// Refusals that need no Slack account to decide are made before the code is
	// exchanged, so no token is ever minted for them.
	describe('refused before the code is exchanged', () => {
		it('sends someone whose session lapsed to sign in, then back to /post-as-you', async () => {
			const fetchSpy = vi.fn();
			vi.stubGlobal('fetch', fetchSpy);

			await expect(GET(grantEvent({ session: null }) as never)).rejects.toMatchObject({
				status: 302,
				location: '/auth/slack?redirectTo=%2Fpost-as-you',
			});
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it('refuses a session that is neither admin nor moderator', async () => {
			const fetchSpy = vi.fn();
			vi.stubGlobal('fetch', fetchSpy);
			const session = { slackUserId: 'UMEM', slackUserName: 'V', isAdmin: false };

			await expect(GET(grantEvent({ session }) as never)).rejects.toMatchObject({ status: 403 });
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});

	// Refusals after the exchange: Slack has issued the token, so it is
	// revoked rather than just dropped.
	describe('refused after the code is exchanged', () => {
		// Slack lets you pick which account to authorize as. One person's
		// commands must never end up posting as another.
		it('refuses — and revokes — a grant from a different Slack account', async () => {
			mockSuccessfulOAuth('URANDOM', 'Someone else');

			await expect(GET(grantEvent() as never)).rejects.toMatchObject({ status: 403 });
			expect(mockSaveUserToken).not.toHaveBeenCalled();
			expect(mockRevokeUserToken).toHaveBeenCalledWith('tok', 'URANDOM');
		});

		// Tokens accumulate at Slack, so revoking this one could take that
		// account's own working grant down with it.
		it('does not revoke when the other account already has its own grant', async () => {
			mockSuccessfulOAuth('UMOD', 'Mo');
			mockLoadUserToken.mockResolvedValue({ ok: true, token: 'xoxp-mods-own' });

			await expect(GET(grantEvent() as never)).rejects.toMatchObject({ status: 403 });
			expect(mockLoadUserToken).toHaveBeenCalledWith(expect.anything(), 'UMOD');
			expect(mockRevokeUserToken).not.toHaveBeenCalled();
		});

		it('does not revoke when it cannot tell whether a grant is stored', async () => {
			mockSuccessfulOAuth('UMOD', 'Mo');
			mockLoadUserToken.mockResolvedValue({ ok: false, reason: 'error' });

			await expect(GET(grantEvent() as never)).rejects.toMatchObject({ status: 403 });
			expect(mockRevokeUserToken).not.toHaveBeenCalled();
		});

		// The role is re-read, not trusted from a session that may be hours old.
		it('refuses — and revokes — for someone removed from both lists since signing in', async () => {
			mockSuccessfulOAuth('UGONE', 'Gone');
			const session = { slackUserId: 'UGONE', slackUserName: 'Gone', isAdmin: true };

			await expect(GET(grantEvent({ session }) as never)).rejects.toMatchObject({ status: 403 });
			expect(mockSaveUserToken).not.toHaveBeenCalled();
			expect(mockRevokeUserToken).toHaveBeenCalledWith('tok', 'UGONE');
		});

		// Their earlier grant is now one the app has no use for: dropped here,
		// before refuse() looks — so the fresh token is revoked too, rather than
		// spared on account of a grant that should not exist.
		it('drops a grant someone removed from both lists had stored earlier', async () => {
			mockSuccessfulOAuth('UGONE', 'Gone');
			const session = { slackUserId: 'UGONE', slackUserName: 'Gone', isAdmin: true };

			await expect(GET(grantEvent({ session }) as never)).rejects.toMatchObject({ status: 403 });
			expect(mockDeleteUserToken).toHaveBeenCalledWith(expect.anything(), 'UGONE');
			expect(mockDeleteUserToken.mock.invocationCallOrder[0]).toBeLessThan(
				mockLoadUserToken.mock.invocationCallOrder[0]!,
			);
		});

		it('says "try again", not "you are not an admin", when the lists cannot be read', async () => {
			mockLoadSettings.mockRejectedValue(new Error('db down'));
			mockSuccessfulOAuth('UADMIN', 'Admin User');

			await expect(GET(grantEvent() as never)).rejects.toMatchObject({ status: 503 });
			expect(mockSaveUserToken).not.toHaveBeenCalled();
			expect(mockRevokeUserToken).toHaveBeenCalledWith('tok', 'UADMIN');
		});

		// The likelier shape of an outage: the token read fails too, so whether
		// a grant is stored is unknown — and an unknown grant is not revoked over.
		it('does not revoke during an outage that also hides the stored grant', async () => {
			mockLoadSettings.mockRejectedValue(new Error('db down'));
			mockLoadUserToken.mockResolvedValue({ ok: false, reason: 'error' });
			mockSuccessfulOAuth('UADMIN', 'Admin User');

			await expect(GET(grantEvent() as never)).rejects.toMatchObject({ status: 503 });
			expect(mockRevokeUserToken).not.toHaveBeenCalled();
			expect(mockDeleteUserToken).not.toHaveBeenCalled();
		});

		it('refuses — and revokes — a token without chat:write', async () => {
			mockSuccessfulOAuth('UADMIN', 'Admin User', 'users:read');

			await expect(GET(grantEvent() as never)).rejects.toMatchObject({ status: 502 });
			expect(mockSaveUserToken).not.toHaveBeenCalled();
			expect(mockRevokeUserToken).toHaveBeenCalledWith('tok', 'UADMIN');
		});

		it('says so, and revokes, when the token cannot be stored', async () => {
			mockSaveUserToken.mockRejectedValue(new Error('db down'));
			mockSuccessfulOAuth('UADMIN', 'Admin User');

			await expect(GET(grantEvent() as never)).rejects.toMatchObject({ status: 500 });
			expect(mockRevokeUserToken).toHaveBeenCalledWith('tok', 'UADMIN');
		});
	});

	describe("Cancel on Slack's screen", () => {
		// Cancel is an answer, not an error.
		it('takes a cancelled grant back to /post-as-you instead of a 403', async () => {
			await expect(GET(grantEvent({ slackError: 'access_denied' }) as never)).rejects.toMatchObject(
				{ status: 302, location: '/post-as-you?declined=1' },
			);
			expect(mockSaveUserToken).not.toHaveBeenCalled();
		});

		it('treats a cancel an hour later the same', async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			try {
				const event = grantEvent({ slackError: 'access_denied' });
				vi.advanceTimersByTime(STATE_TTL_MS + 1000);
				// Without this the test would pass on a live state too.
				expect(verifyState(event.url.searchParams.get('state')!)).toMatchObject({
					ok: false,
					reason: 'expired',
				});

				await expect(GET(event as never)).rejects.toMatchObject({
					location: '/post-as-you?declined=1',
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it('still 403s a cancelled login', async () => {
			await expect(GET(makeEvent({ slackError: 'access_denied' }) as never)).rejects.toMatchObject({
				status: 403,
			});
		});

		it('403s a cancel whose state was rewritten to look like a grant', async () => {
			const { state } = signState({ destination: null, isRetry: false });
			const [payload, signature] = state.split('.');
			const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
			forged.p = 'post-as-you';
			const rawState = `${Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url')}.${signature}`;

			await expect(
				GET(makeEvent({ rawState, slackError: 'access_denied' }) as never),
			).rejects.toMatchObject({ status: 403 });
		});
	});

	describe('restarts', () => {
		it('restarts a grant, not a login, when the state cookie went missing', async () => {
			await expect(GET(grantEvent({ noStateCookie: true }) as never)).rejects.toMatchObject({
				status: 302,
				location: '/auth/slack/post-as-you?retry=1',
			});
		});

		it('restarts a grant, not a login, when its state expired', async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			try {
				const event = grantEvent();
				vi.advanceTimersByTime(STATE_TTL_MS + 1000);

				await expect(GET(event as never)).rejects.toMatchObject({
					status: 302,
					location: '/auth/slack/post-as-you?retry=1',
				});
			} finally {
				vi.useRealTimers();
			}
		});
	});
});

// The failure this recovers from: a link tapped in Slack's in-app webview and
// then reopened in Safari. The URL (and so the state) crosses over; the cookie
// jar does not. Before this, every one of those landed on a bare 400.
describe('GET /auth/slack/callback — recovering a login that lost its cookie', () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue(SETTINGS);
		mockUsersInfo.mockResolvedValue({ ok: true, user: { name: 'Someone' } });
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		errorSpy.mockRestore();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('restarts the login instead of 400ing when the state cookie is missing', async () => {
		await expect(GET(makeEvent({ noStateCookie: true }) as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/slack?retry=1',
		});
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('carries the signed destination into the restart, since the cookie is gone too', async () => {
		await expect(
			GET(makeEvent({ noStateCookie: true, stateDestination: '/members?user=U123' }) as never),
		).rejects.toMatchObject({
			status: 302,
			location: '/auth/slack?redirectTo=%2Fmembers%3Fuser%3DU123&retry=1',
		});
	});

	it('never restarts to an off-site destination', async () => {
		await expect(
			GET(makeEvent({ noStateCookie: true, stateDestination: '//evil.example/steal' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/auth/slack?retry=1' });
	});

	it('gives up with an explanation rather than looping when the retry lost it too', async () => {
		await expect(
			GET(makeEvent({ noStateCookie: true, isRetry: true }) as never),
		).rejects.toMatchObject({
			status: 400,
			body: { message: expect.stringContaining('did not send back the login cookie') },
		});
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('restarts a login that sat on the Slack approval screen past the TTL', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const event = makeEvent();
		vi.setSystemTime(new Date('2026-01-01T01:01:00Z'));

		await expect(GET(event as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/slack?retry=1',
		});
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('keeps the destination when restarting an expired login', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const event = makeEvent({ stateDestination: '/members?user=U123' });
		vi.setSystemTime(new Date('2026-01-01T01:01:00Z'));

		await expect(GET(event as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/slack?redirectTo=%2Fmembers%3Fuser%3DU123&retry=1',
		});
	});

	// Ten minutes used to be the limit, and real logins outlived it while the
	// person signed in to Slack — the restart then showed them Allow a second time.
	it('accepts a login that took longer than ten minutes', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const event = makeEvent();
		vi.setSystemTime(new Date('2026-01-01T00:25:00Z'));
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					jsonRes({ ok: true, authed_user: { id: 'UMEMBER', access_token: 'tok' } }),
				),
		);

		await expect(GET(event as never)).rejects.toMatchObject({ status: 302, location: '/' });
		expect(mockSessionSet).toHaveBeenCalled();
	});

	// The bare UUIDs the previous implementation minted. Only the handful in
	// flight during a deploy ever hit this, and they should not eat a 400.
	it('restarts on a legacy unsigned state instead of rejecting it', async () => {
		await expect(
			GET(makeEvent({ rawState: '550e8400-e29b-41d4-a716-446655440000' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/auth/slack?retry=1' });
	});

	it('rejects — does not restart — a state whose payload was rewritten', async () => {
		const { state, nonce } = signState({ destination: '/', isRetry: false });
		const [payload, signature] = state.split('.');
		const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		forged.d = '/settings';
		const rawState = `${Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url')}.${signature}`;

		await expect(GET(makeEvent({ rawState, cookieState: nonce }) as never)).rejects.toMatchObject({
			status: 400,
		});
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('falls back to the signed destination when only the redirect cookie is missing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonRes({
					ok: true,
					authed_user: { id: 'UADMIN', access_token: 'tok', scope: 'chat:write' },
				}),
			),
		);
		mockSaveUserToken.mockResolvedValue(undefined);

		await expect(
			GET(makeEvent({ stateDestination: '/members?user=U123' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/members?user=U123' });
	});
});

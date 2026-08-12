import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSessionSet = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockUsersInfo = vi.hoisted(() => vi.fn());
const mockSaveUserToken = vi.hoisted(() => vi.fn());
const mockDeleteUserToken = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({
	sessionStore: { set: mockSessionSet },
	db: {},
}));

vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));

vi.mock('$lib/server/slack', () => ({ slack: { users: { info: mockUsersInfo } } }));

vi.mock('$lib/server/user-tokens', () => ({
	saveUserToken: mockSaveUserToken,
	deleteUserToken: mockDeleteUserToken,
}));

vi.mock('$lib/server/env', () => ({
	SLACK_CLIENT_ID: 'client-id',
	SLACK_CLIENT_SECRET: 'client-secret',
	SLACK_SUPERUSER_ID: 'USUPER',
	REDIRECT_URI: 'http://localhost/auth/slack/callback',
}));

vi.mock('$app/environment', () => ({ dev: true }));

import { GET } from './+server.js';

function jsonRes(body: unknown): Response {
	return { json: async () => body } as never;
}

function makeEvent(
	opts: { code?: string; state?: string; cookieState?: string; redirectTo?: string } = {},
) {
	const code = opts.code ?? 'CODE';
	const state = opts.state ?? 'STATE';
	const cookieState = opts.cookieState ?? 'STATE';
	const jar: Record<string, string | undefined> = {
		oauth_state: cookieState,
		oauth_redirect: opts.redirectTo,
	};
	return {
		url: new URL(`http://localhost/auth/slack/callback?code=${code}&state=${state}`),
		cookies: {
			get: vi.fn((name: string) => jar[name]),
			set: vi.fn(),
			delete: vi.fn(),
		},
	};
}

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
		mockLoadSettings.mockResolvedValue({ allowedSlackUserIds: new Set(['UADMIN']) });
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
		errorSpy.mockRestore();
	});

	it('admin gate reads the settings allowed list (DB-backed with env fallback)', async () => {
		mockLoadSettings.mockResolvedValue({ allowedSlackUserIds: new Set(['UFROMDB']) });
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
		await expect(GET(makeEvent({ state: 'A', cookieState: 'B' }) as never)).rejects.toMatchObject({
			status: 400,
		});
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('rejects with 502 when Slack token exchange fails (preserved behavior)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(jsonRes({ ok: false, error: 'invalid_code' })),
		);

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 502 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});
});

// The user token is what lets the admin-defined info commands post as a real
// person instead of as the bot (see user-tokens.ts).
describe('GET /auth/slack/callback — user token capture', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue({ allowedSlackUserIds: new Set(['UADMIN']) });
		mockSaveUserToken.mockResolvedValue(undefined);
		mockDeleteUserToken.mockResolvedValue(undefined);
		mockUsersInfo.mockResolvedValue({ ok: true, user: { name: 'Someone' } });
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		vi.unstubAllGlobals();
	});

	it("stores an admin's token with the scopes Slack granted", async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSaveUserToken).toHaveBeenCalledWith(expect.anything(), {
			slackUserId: 'UADMIN',
			accessToken: 'tok',
			scopes: 'chat:write',
		});
		expect(mockDeleteUserToken).not.toHaveBeenCalled();
	});

	it('clears any stored token for a non-admin instead of keeping it', async () => {
		// Holding a credential the app has no use for is the thing to avoid —
		// this also cleans up after someone is dropped from the allowlist.
		mockSuccessfulOAuth('URANDOM', 'Random User');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSaveUserToken).not.toHaveBeenCalled();
		expect(mockDeleteUserToken).toHaveBeenCalledWith(expect.anything(), 'URANDOM');
	});

	it('records an empty scope string when Slack omits one', async () => {
		mockSuccessfulOAuth('UADMIN', 'Admin User', '');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSaveUserToken).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ scopes: '' }),
		);
	});

	it('still logs the admin in when storing the token fails', async () => {
		// The session is the point of this route; the info commands degrade to
		// "authorize again" on their own.
		mockSaveUserToken.mockRejectedValue(new Error('db down'));
		mockSuccessfulOAuth('UADMIN', 'Admin User');

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 302 });

		expect(mockSessionSet).toHaveBeenCalledTimes(1);
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAppEnv = vi.hoisted(() => ({ dev: false }));
const mockPrivateEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));

vi.mock('$app/environment', () => ({
	get dev() {
		return mockAppEnv.dev;
	},
}));
vi.mock('$env/dynamic/private', () => ({
	get env() {
		return mockPrivateEnv.env;
	},
}));
vi.mock('$lib/server/env', () => ({
	SLACK_CLIENT_ID: 'client-id',
	REDIRECT_URI: 'http://localhost/auth/slack/callback',
}));

import { GET } from './+server.js';

function makeEvent(redirectTo?: string) {
	const url = new URL('http://localhost/auth/slack');
	if (redirectTo !== undefined) url.searchParams.set('redirectTo', redirectTo);
	return { url, cookies: { set: vi.fn(), delete: vi.fn() } };
}

describe('GET /auth/slack', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockAppEnv.dev = false;
		mockPrivateEnv.env = {};
	});

	it('stashes the requested page in a cookie for the callback to read', async () => {
		const event = makeEvent('/members?user=U123');

		await expect(GET(event as never)).rejects.toMatchObject({ status: 302 });

		expect(event.cookies.set).toHaveBeenCalledWith(
			'oauth_redirect',
			'/members?user=U123',
			expect.objectContaining({ httpOnly: true, path: '/' }),
		);
	});

	it('clears any stale redirect cookie when no page was requested', async () => {
		const event = makeEvent();

		await expect(GET(event as never)).rejects.toMatchObject({ status: 302 });

		expect(event.cookies.delete).toHaveBeenCalledWith('oauth_redirect', { path: '/' });
		expect(event.cookies.set).not.toHaveBeenCalledWith(
			'oauth_redirect',
			expect.anything(),
			expect.anything(),
		);
	});

	it('does not stash an off-site redirectTo', async () => {
		const event = makeEvent('https://evil.example/steal');

		await expect(GET(event as never)).rejects.toMatchObject({ status: 302 });

		expect(event.cookies.delete).toHaveBeenCalledWith('oauth_redirect', { path: '/' });
	});

	it('forwards the requested page to the dev-login bypass', async () => {
		mockAppEnv.dev = true;
		mockPrivateEnv.env = { DEV_SLACK_USER_ID: 'UDEV' };

		await expect(GET(makeEvent('/settings') as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/dev-login?redirectTo=%2Fsettings',
		});
	});

	it('redirects to Slack with the state cookie set', async () => {
		const event = makeEvent();

		await expect(GET(event as never)).rejects.toMatchObject({
			status: 302,
			location: expect.stringContaining('https://slack.com/oauth/v2/authorize?'),
		});
		expect(event.cookies.set).toHaveBeenCalledWith(
			'oauth_state',
			expect.any(String),
			expect.objectContaining({ httpOnly: true }),
		);
	});
});

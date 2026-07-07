import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSessionSet = vi.hoisted(() => vi.fn());
const mockAppEnv = vi.hoisted(() => ({ dev: true }));
const mockPrivateEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));

vi.mock('$lib/server/db', () => ({ sessionStore: { set: mockSessionSet } }));
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

import { GET } from './+server.js';

function makeEvent() {
	return { cookies: { set: vi.fn() } };
}

describe('GET /auth/dev-login', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockAppEnv.dev = true;
		mockPrivateEnv.env = {};
	});

	it('404s in production even when DEV_SLACK_USER_ID is set', async () => {
		mockAppEnv.dev = false;
		mockPrivateEnv.env = { DEV_SLACK_USER_ID: 'UDEV' };

		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 404 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('404s in dev when DEV_SLACK_USER_ID is not set', async () => {
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 404 });
		expect(mockSessionSet).not.toHaveBeenCalled();
	});

	it('creates an admin session and redirects in dev with DEV_SLACK_USER_ID set', async () => {
		mockPrivateEnv.env = { DEV_SLACK_USER_ID: 'UDEV' };
		const event = makeEvent();

		await expect(GET(event as never)).rejects.toMatchObject({
			status: 302,
			location: '/pending',
		});

		expect(mockSessionSet).toHaveBeenCalledTimes(1);
		expect(mockSessionSet.mock.calls[0]?.[1]).toEqual({
			slackUserId: 'UDEV',
			slackUserName: 'Dev User',
			isAdmin: true,
		});
		expect(event.cookies.set).toHaveBeenCalledWith(
			'session',
			expect.any(String),
			expect.objectContaining({ httpOnly: true }),
		);
	});
});

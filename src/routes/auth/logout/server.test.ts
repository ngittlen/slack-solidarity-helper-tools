import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDestroy = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db.js', () => ({ db: {}, sessionStore: { destroy: mockDestroy } }));
vi.mock('$lib/server/push.js', () => ({ releasePushDevice: mockRelease }));

import { POST } from './+server.js';

const SESSION = { slackUserId: 'U1' };
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/1';

function event(session: unknown, form: Record<string, string> = {}) {
	const body = new FormData();
	for (const [k, v] of Object.entries(form)) body.set(k, v);
	const cookies = { get: vi.fn(() => 'sid'), delete: vi.fn() };
	return {
		cookies,
		event: {
			cookies,
			locals: { session },
			request: new Request('https://app.example/auth/logout', { method: 'POST', body }),
		} as never,
	};
}

/** POST, which ends in SvelteKit's redirect: returns where it went. */
async function logout(e: never): Promise<string> {
	try {
		await POST(e);
	} catch (err) {
		return (err as { location: string }).location;
	}
	throw new Error('expected a redirect');
}

beforeEach(() => {
	vi.clearAllMocks();
	mockRelease.mockResolvedValue(undefined);
});

describe('POST /auth/logout', () => {
	// A shared device must stop showing the notices of whoever just left it.
	it("gives up this browser's push notifications, then logs out", async () => {
		const { event: e, cookies } = event(SESSION, { push_endpoint: ENDPOINT });
		expect(await logout(e)).toBe('/');
		expect(mockRelease).toHaveBeenCalledWith({}, 'U1', ENDPOINT);
		expect(mockDestroy).toHaveBeenCalledWith('sid');
		expect(cookies.delete).toHaveBeenCalledWith('session', { path: '/' });
	});

	it('releases nothing for a browser without push', async () => {
		await logout(event(SESSION).event);
		expect(mockRelease).not.toHaveBeenCalled();
		expect(mockDestroy).toHaveBeenCalled();
	});

	it('still logs out when the release fails', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockRelease.mockRejectedValue(new Error('db down'));
		await logout(event(SESSION, { push_endpoint: ENDPOINT }).event);
		expect(mockDestroy).toHaveBeenCalledWith('sid');
	});
});

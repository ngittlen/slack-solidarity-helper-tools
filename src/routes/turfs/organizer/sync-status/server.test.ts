import { describe, expect, it, vi } from 'vitest';

const mockView = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({ running: true })));
vi.mock('../manual-sync-view.js', () => ({ manualSyncView: mockView }));

const { GET } = await import('./+server.js');

const event = (session: unknown) => ({ locals: { session } }) as never;

describe('GET /turfs/organizer/sync-status', () => {
	it('returns 401 when not signed in', async () => {
		expect((await GET(event(null))).status).toBe(401);
	});

	it('returns 403 for a signed-in non-admin', async () => {
		expect((await GET(event({ slackUserId: 'U1', isAdmin: false }))).status).toBe(403);
		expect(mockView).not.toHaveBeenCalled();
	});

	it('reports the latest press', async () => {
		const res = await GET(event({ slackUserId: 'U1', isAdmin: true }));
		expect(await res.json()).toEqual({ sync: { running: true } });
	});
});

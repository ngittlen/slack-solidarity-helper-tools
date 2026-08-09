import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockRefresh = vi.hoisted(() => vi.fn());
const mockRunSnapshot = vi.hoisted(() => vi.fn());
const mockProvider = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/door-knock-refresh', () => ({ refreshDoorKnockIfStale: mockRefresh }));
vi.mock('$lib/server/door-knock-snapshot', () => ({ runDoorKnockSnapshot: mockRunSnapshot }));
vi.mock('$lib/server/door-knock-env', () => ({ doorKnockProvider: mockProvider }));

const session = { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: false };

function makeReq(sessionData: object | null = session) {
	return { locals: { session: sessionData } };
}

describe('POST /api/dashboard/door-knock-refresh', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockProvider.mockReturnValue({ ok: true, provider: { name: 'openfield' } });
		mockRefresh.mockResolvedValue({ status: 'refreshed' });
	});

	it('returns 401 with no session', async () => {
		const res = await POST(makeReq(null) as never);
		expect(res.status).toBe(401);
		expect(mockRefresh).not.toHaveBeenCalled();
	});

	// Same audience as the chart itself — not admin-only.
	it('serves any signed-in member', async () => {
		const res = await POST(makeReq() as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'refreshed' });
		expect(mockRefresh).toHaveBeenCalledTimes(1);
	});

	it('runs the snapshot through the throttle, never directly', async () => {
		await POST(makeReq() as never);
		expect(mockRunSnapshot).not.toHaveBeenCalled();
		// The throttle decides whether the injected runner is ever invoked.
		const runner = mockRefresh.mock.calls[0]![1] as () => unknown;
		runner();
		expect(mockRunSnapshot).toHaveBeenCalledTimes(1);
	});

	it('reports a skipped refresh without an error', async () => {
		mockRefresh.mockResolvedValue({ status: 'skipped' });
		const res = await POST(makeReq() as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'skipped' });
	});

	// The page still has valid (older) numbers to show, so a failed snapshot
	// must not read as a broken request.
	it('reports a failed refresh as 200', async () => {
		mockRefresh.mockResolvedValue({ status: 'failed', error: 'openfield 503' });
		const res = await POST(makeReq() as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'failed' });
	});

	it('stays quiet and touches nothing when no provider is configured', async () => {
		mockProvider.mockReturnValue({ ok: false, error: 'DOOR_KNOCK_CHANNEL_ID is not set' });
		const res = await POST(makeReq() as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'unconfigured' });
		expect(mockRefresh).not.toHaveBeenCalled();
	});
});

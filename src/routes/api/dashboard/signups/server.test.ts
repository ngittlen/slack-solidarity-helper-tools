import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './+server.js';

const mockGet = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/dashboard-signups', () => ({
	getDashboardSignups: mockGet,
}));

const session = { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: false };

function makeReq(query = '', sessionData: object | null = session) {
	return {
		url: new URL(`http://localhost/api/dashboard/signups${query}`),
		locals: { session: sessionData },
	};
}

describe('GET /api/dashboard/signups', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGet.mockResolvedValue({ solidarity: [], slack: [] });
	});

	it('returns 401 with no session', async () => {
		const res = await GET(makeReq('', null) as never);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'unauthorized' });
		expect(mockGet).not.toHaveBeenCalled();
	});

	it('serves any signed-in member, not just admins', async () => {
		const res = await GET(makeReq('') as never);
		expect(res.status).toBe(200);
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	it('defaults to days=90 when no query param is provided', async () => {
		await GET(makeReq('') as never);
		expect(mockGet).toHaveBeenCalledWith({}, { days: 90 });
	});

	it('passes a numeric ?days through', async () => {
		await GET(makeReq('?days=30') as never);
		expect(mockGet).toHaveBeenCalledWith({}, { days: 30 });
	});

	it('clamps ?days to MAX_DAYS=365', async () => {
		await GET(makeReq('?days=9999') as never);
		expect(mockGet).toHaveBeenCalledWith({}, { days: 365 });
	});

	it('falls back to 90 for non-numeric ?days', async () => {
		await GET(makeReq('?days=abc') as never);
		expect(mockGet).toHaveBeenCalledWith({}, { days: 90 });
	});

	it('falls back to 90 for non-positive ?days', async () => {
		await GET(makeReq('?days=0') as never);
		expect(mockGet).toHaveBeenCalledWith({}, { days: 90 });
		await GET(makeReq('?days=-5') as never);
		expect(mockGet).toHaveBeenLastCalledWith({}, { days: 90 });
	});

	it('returns the JSON payload from getDashboardSignups verbatim', async () => {
		const payload = {
			solidarity: [{ date: '2026-05-10', total: 3, byChapter: [] }],
			slack: [{ date: '2026-05-10', total: 1, byChapter: [] }],
		};
		mockGet.mockResolvedValueOnce(payload);
		const res = await GET(makeReq('') as never);
		expect(await res.json()).toEqual(payload);
	});
});

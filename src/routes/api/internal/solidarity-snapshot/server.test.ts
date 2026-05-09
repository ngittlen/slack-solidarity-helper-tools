import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockRunSnapshot = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/solidarity-snapshot', () => ({
	runSolidaritySnapshot: mockRunSnapshot,
}));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/env', () => ({
	INTERNAL_CRON_SECRET: 'test-cron-secret',
	SOLIDARITY_API_TOKEN: 'test-solidarity-token',
}));

function makeReq(query: string) {
	return { url: new URL(`http://localhost/api/internal/solidarity-snapshot${query}`) };
}

describe('POST /api/internal/solidarity-snapshot', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRunSnapshot.mockResolvedValue({
			date: '2026-05-06',
			rangeStartUnix: 1,
			rangeEndUnix: 2,
			usersScanned: 0,
			usersInRange: 0,
			rows: [],
		});
	});

	it('returns 401 when key is missing', async () => {
		const res = await POST(makeReq('') as never);
		expect(res.status).toBe(401);
		expect(mockRunSnapshot).not.toHaveBeenCalled();
	});

	it('returns 401 when key is wrong', async () => {
		const res = await POST(makeReq('?key=wrong') as never);
		expect(res.status).toBe(401);
		expect(mockRunSnapshot).not.toHaveBeenCalled();
	});

	it('runs the snapshot for yesterday when no date is provided', async () => {
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(200);
		expect(mockRunSnapshot).toHaveBeenCalledWith(expect.anything(), 'test-solidarity-token', {
			date: undefined,
		});
	});

	it('passes the date param through to runSolidaritySnapshot', async () => {
		const res = await POST(makeReq('?key=test-cron-secret&date=2026-04-01') as never);
		expect(res.status).toBe(200);
		expect(mockRunSnapshot).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
			date: '2026-04-01',
		});
	});

	it('returns 500 with the error message when the snapshot throws', async () => {
		mockRunSnapshot.mockRejectedValueOnce(new Error('solidarity 503'));
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'solidarity 503' });
	});
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { dateRangeUtc, runSolidaritySnapshot } from './solidarity-snapshot.js';

function makeDb() {
	const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
	const values = vi.fn(() => ({ onConflictDoUpdate }));
	const insert = vi.fn(() => ({ values }));
	return {
		db: { insert } as unknown as Parameters<typeof runSolidaritySnapshot>[0],
		insert,
		values,
		onConflictDoUpdate,
	};
}

const chaptersResponse = {
	ok: true,
	status: 200,
	json: async () => ({
		data: [
			{ id: 100, name: 'Alpha' },
			{ id: 200, name: 'Beta' },
		],
	}),
} as Response;

describe('dateRangeUtc', () => {
	it('returns yesterday UTC when no date is given', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-07T15:30:00Z'));
		const r = dateRangeUtc();
		expect(r.dateStr).toBe('2026-05-06');
		expect(r.startUnix).toBe(Math.floor(Date.UTC(2026, 4, 6) / 1000));
		expect(r.endUnix).toBe(Math.floor(Date.UTC(2026, 4, 7) / 1000));
		vi.useRealTimers();
	});

	it('parses an explicit YYYY-MM-DD date as UTC midnight', () => {
		const r = dateRangeUtc('2026-04-01');
		expect(r.dateStr).toBe('2026-04-01');
		expect(r.startUnix).toBe(Math.floor(Date.UTC(2026, 3, 1) / 1000));
		expect(r.endUnix).toBe(Math.floor(Date.UTC(2026, 3, 2) / 1000));
	});

	it('rejects malformed dates', () => {
		expect(() => dateRangeUtc('not-a-date')).toThrow(/Invalid date/);
		expect(() => dateRangeUtc('2026/04/01')).toThrow(/Invalid date/);
	});
});

describe('runSolidaritySnapshot', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function pageResponse(data: unknown[]) {
		return {
			ok: true,
			status: 200,
			json: async () => ({ data }),
		} as Response;
	}

	it('filters users to the target date range and buckets by chapter', async () => {
		const target = '2026-04-15';
		const inRange = '2026-04-15T12:00:00Z';
		const before = '2026-04-14T23:59:59Z';
		const after = '2026-04-16T00:00:01Z';

		fetchMock.mockResolvedValueOnce(chaptersResponse).mockResolvedValueOnce(
			pageResponse([
				{ chapter_id: 100, chapter_ids: [], created_at: inRange },
				{ chapter_id: null, chapter_ids: [100, 200], created_at: inRange },
				{ chapter_id: null, chapter_ids: [], created_at: inRange },
				{ chapter_id: 100, chapter_ids: [], created_at: before },
				{ chapter_id: 200, chapter_ids: [], created_at: after },
			]),
		);

		const { db, values } = makeDb();
		const result = await runSolidaritySnapshot(db, 'token', { date: target });

		expect(result.date).toBe(target);
		expect(result.usersScanned).toBe(5);
		expect(result.usersInRange).toBe(3);
		// The -2 sentinel carries the distinct-user count (3). Sum of the
		// per-chapter buckets is 4 because the multi-chapter user is counted
		// in both Alpha and Beta — exactly the double-count the sentinel exists
		// to correct.
		expect(result.rows).toEqual([
			{ date: target, chapterId: -2, chapterName: null, count: 3 },
			{ date: target, chapterId: -1, chapterName: null, count: 1 },
			{ date: target, chapterId: 100, chapterName: 'Alpha', count: 2 },
			{ date: target, chapterId: 200, chapterName: 'Beta', count: 1 },
		]);
		expect(values).toHaveBeenCalledTimes(4);
	});

	it('paginates until a short page is returned', async () => {
		const fullPage = Array.from({ length: 100 }, () => ({
			chapter_id: 100,
			chapter_ids: [],
			created_at: '2026-04-15T01:00:00Z',
		}));
		fetchMock
			.mockResolvedValueOnce(chaptersResponse)
			.mockResolvedValueOnce(pageResponse(fullPage))
			.mockResolvedValueOnce(pageResponse(fullPage.slice(0, 10)));

		const { db } = makeDb();
		const result = await runSolidaritySnapshot(db, 'token', { date: '2026-04-15' });

		// 1 chapters call + 2 users calls
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(result.usersScanned).toBe(110);
		// First row is the distinct-total sentinel (-2), value = distinct user
		// count. All 110 users are in chapter 100 only, so chapter 100's count
		// matches.
		expect(result.rows[0]).toEqual({
			date: '2026-04-15',
			chapterId: -2,
			chapterName: null,
			count: 110,
		});
		expect(result.rows[1]?.chapterId).toBe(100);
		expect(result.rows[1]?.count).toBe(110);
	});

	it('does not write when dryRun is true', async () => {
		fetchMock
			.mockResolvedValueOnce(chaptersResponse)
			.mockResolvedValueOnce(
				pageResponse([{ chapter_id: 100, chapter_ids: [], created_at: '2026-04-15T01:00:00Z' }]),
			);
		const { db, insert } = makeDb();
		const result = await runSolidaritySnapshot(db, 'token', {
			date: '2026-04-15',
			dryRun: true,
		});
		expect(insert).not.toHaveBeenCalled();
		// 1 sentinel row + 1 chapter row
		expect(result.rows).toHaveLength(2);
		expect(result.rows[0]?.chapterId).toBe(-2);
	});

	it('throws when /v1/chapters fails', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 503,
			text: async () => 'service unavailable',
		} as Response);
		const { db } = makeDb();
		await expect(runSolidaritySnapshot(db, 'token', { date: '2026-04-15' })).rejects.toThrow(
			/\/v1\/chapters.*503/,
		);
	});

	it('throws when /v1/users fails after chapters succeed', async () => {
		fetchMock.mockResolvedValueOnce(chaptersResponse).mockResolvedValueOnce({
			ok: false,
			status: 503,
			text: async () => 'service unavailable',
		} as Response);
		const { db } = makeDb();
		await expect(runSolidaritySnapshot(db, 'token', { date: '2026-04-15' })).rejects.toThrow(
			/\/v1\/users.*503/,
		);
	});

	it('leaves chapterName null when /v1/chapters did not return that id', async () => {
		fetchMock
			.mockResolvedValueOnce(chaptersResponse)
			.mockResolvedValueOnce(
				pageResponse([{ chapter_id: 999, chapter_ids: [], created_at: '2026-04-15T01:00:00Z' }]),
			);
		const { db } = makeDb();
		const result = await runSolidaritySnapshot(db, 'token', { date: '2026-04-15' });
		expect(result.rows).toEqual([
			{ date: '2026-04-15', chapterId: -2, chapterName: null, count: 1 },
			{ date: '2026-04-15', chapterId: 999, chapterName: null, count: 1 },
		]);
	});

	it('omits the distinct-total sentinel when no users land in range', async () => {
		fetchMock.mockResolvedValueOnce(chaptersResponse).mockResolvedValueOnce(
			pageResponse([
				// Updated_at puts these into the result, but created_at is outside
				// the target date so they get filtered out below.
				{ chapter_id: 100, chapter_ids: [], created_at: '2026-04-10T00:00:00Z' },
			]),
		);
		const { db } = makeDb();
		const result = await runSolidaritySnapshot(db, 'token', { date: '2026-04-15' });
		expect(result.usersInRange).toBe(0);
		expect(result.rows).toEqual([]);
	});

	it('sentinel count is the distinct user total even when users span multiple chapters', async () => {
		fetchMock.mockResolvedValueOnce(chaptersResponse).mockResolvedValueOnce(
			pageResponse([
				// Two users, both in two chapters. Distinct = 2; sum-of-buckets = 4.
				{ chapter_id: null, chapter_ids: [100, 200], created_at: '2026-04-15T01:00:00Z' },
				{ chapter_id: null, chapter_ids: [100, 200], created_at: '2026-04-15T02:00:00Z' },
			]),
		);
		const { db } = makeDb();
		const result = await runSolidaritySnapshot(db, 'token', { date: '2026-04-15' });
		const sentinel = result.rows.find((r) => r.chapterId === -2);
		expect(sentinel?.count).toBe(2);
		const sumOfChapters = result.rows
			.filter((r) => r.chapterId !== -2)
			.reduce((a, r) => a + r.count, 0);
		expect(sumOfChapters).toBe(4);
	});
});

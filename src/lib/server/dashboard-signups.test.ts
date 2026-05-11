import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getDashboardSignups, loadSlackSignups, loadSolidaritySignups } from './dashboard-signups.js';

// The aggregation function makes two kinds of db calls:
//   - select().from().where().orderBy() and select().from() for Solidarity
//     snapshot rows and chapter-name lookup
//   - db.all(sql`...`) three times for Slack (per-chapter, null-chapter, total)
//
// We model the chained select with a queue so we can return different rows for
// the snapshot query vs the chapter-name query, and a separate queue for db.all.

interface MockDb {
	select: ReturnType<typeof vi.fn>;
	all: ReturnType<typeof vi.fn>;
	_pushSelect: (rows: unknown[]) => void;
	_pushAll: (rows: unknown[]) => void;
	/** All values passed to any `.where()` call across every select chain, in
	 *  call order. Each entry is the single SQL object drizzle was handed. */
	_whereArgs: () => unknown[];
}

// Drizzle's SQL objects contain circular references (column → table → column),
// so plain JSON.stringify throws. WeakSet-based replacer is enough for our needs.
function safeStringify(obj: unknown): string {
	const seen = new WeakSet();
	return JSON.stringify(obj, (_key, value: unknown) => {
		if (typeof value === 'object' && value !== null) {
			if (seen.has(value as object)) return '[Circular]';
			seen.add(value as object);
		}
		return value;
	});
}

function makeDb(): MockDb {
	const selectQueue: unknown[][] = [];
	const allQueue: unknown[][] = [];
	const whereArgs: unknown[] = [];

	function chain(rows: unknown[]) {
		const orderBy = vi.fn().mockResolvedValue(rows);
		const where = vi.fn((arg: unknown) => {
			whereArgs.push(arg);
			return { orderBy, then: (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r) };
		});
		const from = vi.fn(() => ({
			where,
			orderBy,
			then: (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r),
		}));
		return { from };
	}

	const select = vi.fn(() => {
		const rows = selectQueue.shift() ?? [];
		return chain(rows);
	});
	const all = vi.fn(async () => allQueue.shift() ?? []);

	return {
		select,
		all,
		_pushSelect: (rows) => selectQueue.push(rows),
		_pushAll: (rows) => allQueue.push(rows),
		_whereArgs: () => whereArgs,
	};
}

const NOW = new Date('2026-05-10T12:00:00Z');

describe('getDashboardSignups', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('groups Solidarity snapshot rows by date and sums total', async () => {
		const db = makeDb();
		// Snapshot select
		db._pushSelect([
			{ date: '2026-05-09', chapterId: 100, chapterName: 'Alpha', count: 3 },
			{ date: '2026-05-09', chapterId: 200, chapterName: 'Beta', count: 5 },
			{ date: '2026-05-10', chapterId: 100, chapterName: 'Alpha', count: 7 },
		]);
		// Slack chapter-name select
		db._pushSelect([]);
		db._pushAll([]); // chapter rows
		db._pushAll([]); // null chapter rows
		db._pushAll([]); // total rows

		const result = await getDashboardSignups(
			db as never,
			{ days: 90, now: NOW },
		);

		expect(result.solidarity).toEqual([
			{
				date: '2026-05-09',
				total: 8,
				byChapter: [
					{ chapterId: 100, chapterName: 'Alpha', count: 3 },
					{ chapterId: 200, chapterName: 'Beta', count: 5 },
				],
			},
			{
				date: '2026-05-10',
				total: 7,
				byChapter: [{ chapterId: 100, chapterName: 'Alpha', count: 7 }],
			},
		]);
	});

	it('maps Solidarity sentinel chapterId=-1 to null/null in the response', async () => {
		const db = makeDb();
		db._pushSelect([
			{ date: '2026-05-10', chapterId: -1, chapterName: null, count: 4 },
			{ date: '2026-05-10', chapterId: 100, chapterName: 'Alpha', count: 2 },
		]);
		db._pushSelect([]);
		db._pushAll([]);
		db._pushAll([]);
		db._pushAll([]);

		const result = await getDashboardSignups(db as never, { days: 90, now: NOW });

		expect(result.solidarity[0]!.byChapter).toEqual([
			{ chapterId: 100, chapterName: 'Alpha', count: 2 },
			{ chapterId: null, chapterName: null, count: 4 },
		]);
		expect(result.solidarity[0]!.total).toBe(6);
	});

	it('builds Slack days from per-chapter, null-chapter, and total queries', async () => {
		const db = makeDb();
		db._pushSelect([]); // no Solidarity snapshot rows
		db._pushSelect([{ chapterId: 100, chapterName: 'Alpha' }]); // chapter names
		db._pushAll([
			{ date: '2026-05-10', chapter_id: 100, count: 4 },
			{ date: '2026-05-10', chapter_id: 200, count: 1 },
		]);
		db._pushAll([{ date: '2026-05-10', count: 2 }]); // null-chapter bucket
		// Distinct user total — less than 4+1+2=7 because some users belong to
		// multiple chapters and are counted once here.
		db._pushAll([{ date: '2026-05-10', total: 5 }]);

		const result = await getDashboardSignups(db as never, { days: 90, now: NOW });

		expect(result.slack).toEqual([
			{
				date: '2026-05-10',
				total: 5,
				byChapter: [
					{ chapterId: 100, chapterName: 'Alpha', count: 4 },
					{ chapterId: 200, chapterName: 'Chapter #200', count: 1 },
					{ chapterId: null, chapterName: null, count: 2 },
				],
			},
		]);
	});

	it('falls back to "Chapter #N" when no snapshot row carries the name', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]); // no chapter names known
		db._pushAll([{ date: '2026-05-10', chapter_id: 999, count: 3 }]);
		db._pushAll([]);
		db._pushAll([{ date: '2026-05-10', total: 3 }]);

		const result = await getDashboardSignups(db as never, { days: 90, now: NOW });

		expect(result.slack[0]!.byChapter[0]).toEqual({
			chapterId: 999,
			chapterName: 'Chapter #999',
			count: 3,
		});
	});

	it('asks both queries for dates >= today − (days − 1) at UTC midnight', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushAll([]);
		db._pushAll([]);
		db._pushAll([]);

		await getDashboardSignups(db as never, { days: 7, now: NOW });

		// today (UTC) is 2026-05-10; days=7 → start = 2026-05-04
		// Spot-check the SQL fragments passed to db.all include that date string.
		const allArgs = db.all.mock.calls.map((c) => JSON.stringify(c[0]));
		for (const s of allArgs) {
			expect(s).toContain('2026-05-04');
		}
	});

	it('days=1 covers only today (UTC)', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushAll([]);
		db._pushAll([]);
		db._pushAll([]);

		await getDashboardSignups(db as never, { days: 1, now: NOW });

		const allArgs = db.all.mock.calls.map((c) => JSON.stringify(c[0]));
		for (const s of allArgs) {
			expect(s).toContain('2026-05-10');
		}
	});

	it('returns empty arrays when there is no data', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushAll([]);
		db._pushAll([]);
		db._pushAll([]);

		const result = await getDashboardSignups(db as never, { days: 90, now: NOW });
		expect(result).toEqual({ solidarity: [], slack: [] });
	});

	it('sorts Slack days ascending by date', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushAll([
			{ date: '2026-05-10', chapter_id: 100, count: 1 },
			{ date: '2026-05-08', chapter_id: 100, count: 1 },
			{ date: '2026-05-09', chapter_id: 100, count: 1 },
		]);
		db._pushAll([]);
		db._pushAll([
			{ date: '2026-05-10', total: 1 },
			{ date: '2026-05-08', total: 1 },
			{ date: '2026-05-09', total: 1 },
		]);

		const result = await getDashboardSignups(db as never, { days: 90, now: NOW });
		expect(result.slack.map((d) => d.date)).toEqual(['2026-05-08', '2026-05-09', '2026-05-10']);
	});

	describe('excludedChapterIds', () => {
		it('omits a NOT IN clause from every query when the set is empty', async () => {
			const db = makeDb();
			db._pushSelect([]);
			db._pushSelect([]);
			db._pushAll([]);
			db._pushAll([]);
			db._pushAll([]);

			await getDashboardSignups(db as never, { days: 90, now: NOW });

			const allSql = db.all.mock.calls.map((c) => JSON.stringify(c[0]));
			for (const s of allSql) {
				expect(s).not.toContain('NOT IN');
				expect(s).not.toContain('EXISTS');
			}
		});

		it('passes the exclusion through to every query when the set is non-empty', async () => {
			const db = makeDb();
			db._pushSelect([]);
			db._pushSelect([]);
			db._pushAll([]);
			db._pushAll([]);
			db._pushAll([]);

			await getDashboardSignups(db as never, {
				days: 90,
				now: NOW,
				excludedChapterIds: new Set([1008, 1999]),
			});

			// db.all is called three times for Slack (per-chapter, null-chapter, total).
			// chapter and total queries get a NOT IN clause; null-chapter doesn't,
			// because those rows have no chapter IDs to match against.
			const allSql = db.all.mock.calls.map((c) => JSON.stringify(c[0]));
			expect(allSql).toHaveLength(3);
			expect(allSql[0]).toContain('NOT IN');
			expect(allSql[0]).toContain('1008');
			expect(allSql[0]).toContain('1999');
			expect(allSql[1]).not.toContain('NOT IN');
			expect(allSql[2]).toContain('EXISTS');
			expect(allSql[2]).toContain('NOT IN');
			expect(allSql[2]).toContain('1008');
			expect(allSql[2]).toContain('1999');

			// The Solidarity query is built via drizzle's query builder, so the
			// exclusion lands in the `.where()` call as an AND of (gte, notInArray).
			// The exact internal shape is opaque, so we only assert the SQL produced
			// references the excluded ID — drizzle stringifies notInArray with a
			// `not in` clause and inlines the chapter_id column.
			const whereSql = db._whereArgs().map((arg) => safeStringify(arg));
			expect(whereSql.length).toBeGreaterThan(0);
			const solidarityWhere = whereSql[0]!;
			expect(solidarityWhere).toMatch(/not in/i);
			expect(solidarityWhere).toContain('1008');
			expect(solidarityWhere).toContain('1999');
		});

		it('loadSolidaritySignups receives the exclusion (top-level entry point)', async () => {
			const db = makeDb();
			db._pushSelect([]);
			db._pushSelect([]); // chapter-name lookup not needed here, but loaded by loadChapterNames

			await loadSolidaritySignups(db as never, {
				days: 30,
				now: NOW,
				excludedChapterIds: new Set([42]),
			});

			const whereSql = db._whereArgs().map((arg) => safeStringify(arg));
			expect(whereSql.length).toBeGreaterThan(0);
			expect(whereSql[0]).toMatch(/not in/i);
			expect(whereSql[0]).toContain('42');
		});

		it('loadSlackSignups receives the exclusion (top-level entry point)', async () => {
			const db = makeDb();
			db._pushSelect([]); // chapter-name lookup
			db._pushAll([]);
			db._pushAll([]);
			db._pushAll([]);

			await loadSlackSignups(db as never, {
				days: 30,
				now: NOW,
				excludedChapterIds: new Set([42]),
			});

			const allSql = db.all.mock.calls.map((c) => JSON.stringify(c[0]));
			expect(allSql[0]).toContain('NOT IN');
			expect(allSql[0]).toContain('42');
			expect(allSql[2]).toContain('EXISTS');
			expect(allSql[2]).toContain('42');
		});
	});
});

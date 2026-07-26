import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { loadDoorKnockTicker, TICKER_TOP_N } from './door-knock-ticker.js';

// The point of this module is the SUM/GROUP BY/ORDER BY across codes, so it
// runs against a real in-memory SQLite rather than a mocked builder chain.
let client: Client;
let db: LibSQLDatabase<Record<string, unknown>>;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await client.execute(`CREATE TABLE door_knock_canvasser_daily (
		date text NOT NULL,
		code text NOT NULL,
		canvasser text NOT NULL,
		attempts integer DEFAULT 0 NOT NULL,
		contacts integer DEFAULT 0 NOT NULL,
		chapter_name text DEFAULT '' NOT NULL,
		PRIMARY KEY(date, code, canvasser)
	)`);
});

afterEach(() => client.close());

async function seed(
	rows: Array<
		[date: string, code: string, canvasser: string, attempts: number, chapter?: string]
	>,
): Promise<void> {
	for (const [date, code, canvasser, attempts, chapter] of rows) {
		await client.execute({
			sql: 'INSERT INTO door_knock_canvasser_daily VALUES (?, ?, ?, ?, 0, ?)',
			args: [date, code, canvasser, attempts, chapter ?? 'Wayne'],
		});
	}
}

describe('loadDoorKnockTicker', () => {
	it('returns an empty ticker when nothing has been recorded', async () => {
		expect(await loadDoorKnockTicker(db)).toEqual({ date: null, entries: [] });
	});

	// One person can canvass under several codes in a day; the ticker shows
	// their day, not their best conversation.
	it('sums a person across conversation codes', async () => {
		await seed([
			['2026-07-25', 'ZT2H5D', 'Maria T.', 40],
			['2026-07-25', 'AB12CD', 'Maria T.', 62],
			['2026-07-25', 'ZT2H5D', 'James R.', 71],
		]);

		expect(await loadDoorKnockTicker(db)).toEqual({
			date: '2026-07-25',
			entries: [
				{ canvasser: 'Maria T.', doors: 102, chapter: 'Wayne', rank: 1 },
				{ canvasser: 'James R.', doors: 71, chapter: 'Wayne', rank: 2 },
			],
		});
	});

	it('only covers the most recent day', async () => {
		await seed([
			['2026-07-24', 'ZT2H5D', 'Yesterday Y.', 900],
			['2026-07-25', 'ZT2H5D', 'Today T.', 5],
		]);

		const ticker = await loadDoorKnockTicker(db);
		expect(ticker.date).toBe('2026-07-25');
		expect(ticker.entries).toEqual([
			{ canvasser: 'Today T.', doors: 5, chapter: 'Wayne', rank: 1 },
		]);
	});

	// Overnight the table's latest date is the day that just finished, so the
	// board holds those standings rather than going blank.
	it('holds the last day with data rather than emptying out', async () => {
		await seed([['2026-07-24', 'ZT2H5D', 'Maria T.', 88]]);

		const ticker = await loadDoorKnockTicker(db);
		expect(ticker.date).toBe('2026-07-24');
		expect(ticker.entries).toHaveLength(1);
	});

	it('ranks by doors descending and caps the list', async () => {
		await seed(
			Array.from({ length: TICKER_TOP_N + 5 }, (_, i): [string, string, string, number] => [
				'2026-07-25',
				'ZT2H5D',
				`Person ${String(i).padStart(2, '0')}`,
				i + 1,
			]),
		);

		const { entries } = await loadDoorKnockTicker(db);
		expect(entries).toHaveLength(TICKER_TOP_N);
		expect(entries[0]).toEqual({ canvasser: 'Person 14', doors: 15, chapter: 'Wayne', rank: 1 });
		expect(entries.map((e) => e.doors)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
		expect(entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it('honours a custom limit', async () => {
		await seed([
			['2026-07-25', 'ZT2H5D', 'A', 30],
			['2026-07-25', 'ZT2H5D', 'B', 20],
			['2026-07-25', 'ZT2H5D', 'C', 10],
		]);

		const { entries } = await loadDoorKnockTicker(db, { limit: 2 });
		expect(entries.map((e) => e.canvasser)).toEqual(['A', 'B']);
	});

	// A board that reshuffles tied names on every 30-minute refresh looks broken.
	it('breaks ties by name so the order is stable between refreshes', async () => {
		await seed([
			['2026-07-25', 'ZT2H5D', 'Zoe', 50],
			['2026-07-25', 'ZT2H5D', 'Adam', 50],
			['2026-07-25', 'ZT2H5D', 'Mel', 50],
		]);

		const { entries } = await loadDoorKnockTicker(db);
		expect(entries.map((e) => e.canvasser)).toEqual(['Adam', 'Mel', 'Zoe']);
	});

	it('leaves out people whose day is still zero', async () => {
		await seed([
			['2026-07-25', 'ZT2H5D', 'Knocked', 12],
			['2026-07-25', 'ZT2H5D', 'Signed in only', 0],
		]);

		const { entries } = await loadDoorKnockTicker(db);
		expect(entries).toEqual([{ canvasser: 'Knocked', doors: 12, chapter: 'Wayne', rank: 1 }]);
	});

	// A ticker cell has room for one region, so someone split across chapters
	// is shown under the one they knocked most in.
	it('names the chapter a person knocked the most doors in', async () => {
		await seed([
			['2026-07-25', 'ZT2H5D', 'Maria T.', 40, 'Washtenaw'],
			['2026-07-25', 'AB12CD', 'Maria T.', 62, 'Wayne'],
		]);

		const { entries } = await loadDoorKnockTicker(db);
		expect(entries).toEqual([
			{ canvasser: 'Maria T.', doors: 102, chapter: 'Wayne', rank: 1 },
		]);
	});

	it('breaks a chapter tie alphabetically so the region does not flip', async () => {
		await seed([
			['2026-07-25', 'ZT2H5D', 'Split S.', 50, 'Wayne'],
			['2026-07-25', 'AB12CD', 'Split S.', 50, 'Ingham'],
		]);

		const { entries } = await loadDoorKnockTicker(db);
		expect(entries[0]).toEqual({
			canvasser: 'Split S.',
			doors: 100,
			chapter: 'Ingham',
			rank: 1,
		});
	});

	it('leaves the region blank rather than inventing one', async () => {
		await seed([['2026-07-25', 'ZT2H5D', 'Nameless N.', 12, '']]);
		expect((await loadDoorKnockTicker(db)).entries[0]?.chapter).toBe('');
	});

	it('reports an empty ticker when the latest day is all zeros', async () => {
		await seed([['2026-07-25', 'ZT2H5D', 'Signed in only', 0]]);
		expect(await loadDoorKnockTicker(db)).toEqual({ date: null, entries: [] });
	});
});

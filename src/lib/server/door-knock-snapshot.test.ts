import { describe, it, expect, vi } from 'vitest';
import { runDoorKnockSnapshot } from './door-knock-snapshot.js';
import type { DoorKnockDayRows, DoorKnockProvider } from './door-knock-provider.js';
import { doorKnockCanvasserDaily, doorKnockDaily } from './schema.js';

interface CapturedInsert {
	table: unknown;
	values: unknown;
	onConflict: unknown;
}

function makeDb() {
	const inserts: CapturedInsert[] = [];
	const insert = vi.fn((table: unknown) => ({
		values: (values: unknown) => ({
			onConflictDoUpdate: (onConflict: unknown) => {
				inserts.push({ table, values, onConflict });
				return Promise.resolve();
			},
		}),
	}));
	return { db: { insert } as never, inserts };
}

const DAY: DoorKnockDayRows = {
	date: '2026-07-06',
	perTurf: [
		{ code: 'AB12CD', chapterName: 'Wayne', attempts: 0, contacts: 0 },
		{ code: 'ZT2H5D', chapterName: 'Washtenaw', attempts: 42, contacts: 13 },
	],
	perCanvasser: [
		{ code: 'ZT2H5D', chapterName: 'Washtenaw', canvasser: 'A', attempts: 30, contacts: 9 },
		{ code: 'ZT2H5D', chapterName: 'Washtenaw', canvasser: 'B', attempts: 12, contacts: 4 },
	],
	warnings: [],
	details: { anything: 'the provider likes' },
};

// A stand-in with no canvassing tool behind it at all — which is the point:
// the writer must work for any provider, so its tests must not know about
// Openfield codes, canvases, or conversation ids.
function makeProvider(rows: DoorKnockDayRows = DAY): DoorKnockProvider {
	return {
		name: 'test-provider',
		dateFor: () => rows.date,
		collect: vi.fn(async () => rows),
	};
}

describe('runDoorKnockSnapshot', () => {
	it('writes the provider rows and summarises the run', async () => {
		const { db, inserts } = makeDb();

		const result = await runDoorKnockSnapshot(db, makeProvider());

		expect(result).toEqual({
			provider: 'test-provider',
			date: '2026-07-06',
			rowsWritten: 2,
			canvasserRowsWritten: 2,
			totalAttempts: 42,
			warnings: [],
			details: { anything: 'the provider likes' },
		});

		expect(inserts.filter((i) => i.table === doorKnockDaily).map((i) => i.values)).toEqual([
			{ date: '2026-07-06', code: 'AB12CD', chapterName: 'Wayne', attempts: 0, contacts: 0 },
			{ date: '2026-07-06', code: 'ZT2H5D', chapterName: 'Washtenaw', attempts: 42, contacts: 13 },
		]);
		expect(inserts.filter((i) => i.table === doorKnockCanvasserDaily).map((i) => i.values)).toEqual(
			[
				{
					date: '2026-07-06',
					code: 'ZT2H5D',
					chapterName: 'Washtenaw',
					canvasser: 'A',
					attempts: 30,
					contacts: 9,
				},
				{
					date: '2026-07-06',
					code: 'ZT2H5D',
					chapterName: 'Washtenaw',
					canvasser: 'B',
					attempts: 12,
					contacts: 4,
				},
			],
		);
	});

	// The date is the provider's to decide (it has to match the rollover of
	// whatever it reads), so the writer must take it from collect() rather than
	// stamping one of its own.
	it('stamps rows with the date the provider returned', async () => {
		const { db, inserts } = makeDb();
		const provider = makeProvider({ ...DAY, date: '2026-11-02' });

		const result = await runDoorKnockSnapshot(db, provider);

		expect(result.date).toBe('2026-11-02');
		for (const insert of inserts) {
			expect(insert.values).toMatchObject({ date: '2026-11-02' });
		}
	});

	it('passes the injected clock to the provider', async () => {
		const { db } = makeDb();
		const provider = makeProvider();
		const now = new Date('2026-07-07T02:30:00Z');

		await runDoorKnockSnapshot(db, provider, () => now);

		expect(provider.collect).toHaveBeenCalledWith(now);
	});

	// The upsert's set clause is the re-run path: rows written by an earlier run
	// already exist, so anything missing here is silently never refreshed.
	// chapter_name was omitted once and regions stayed blank on the board even
	// after re-running the snapshot.
	it('refreshes the chapter on a re-run, not just the counts', async () => {
		const { db, inserts } = makeDb();

		await runDoorKnockSnapshot(db, makeProvider());

		const canvasserInserts = inserts.filter((i) => i.table === doorKnockCanvasserDaily);
		expect(canvasserInserts.length).toBeGreaterThan(0);
		for (const insert of canvasserInserts) {
			expect(insert.onConflict).toMatchObject({
				set: { chapterName: 'Washtenaw', attempts: expect.any(Number) },
			});
		}
		for (const insert of inserts.filter((i) => i.table === doorKnockDaily)) {
			expect(insert.onConflict).toMatchObject({
				set: { chapterName: expect.any(String), attempts: expect.any(Number) },
			});
		}
	});

	// Warnings are the provider's words — the writer passes them through for the
	// scheduled endpoint to post, and never composes or filters them.
	it('passes provider warnings through untouched', async () => {
		const { db } = makeDb();
		const warnings = ['something a human needs to look at'];

		const result = await runDoorKnockSnapshot(db, makeProvider({ ...DAY, warnings }));

		expect(result.warnings).toEqual(warnings);
	});

	it('writes nothing for an empty day but still reports it', async () => {
		const { db, inserts } = makeDb();

		const result = await runDoorKnockSnapshot(
			db,
			makeProvider({ ...DAY, perTurf: [], perCanvasser: [] }),
		);

		expect(inserts).toEqual([]);
		expect(result).toMatchObject({ rowsWritten: 0, canvasserRowsWritten: 0, totalAttempts: 0 });
	});

	// collect() throwing means "no usable data" — the writer must not swallow it
	// into an empty day, which would overwrite good rows with nothing.
	it('propagates a provider failure without writing', async () => {
		const { db, inserts } = makeDb();
		const provider: DoorKnockProvider = {
			name: 'test-provider',
			dateFor: () => '2026-07-06',
			collect: vi.fn(async () => {
				throw new Error('upstream 503');
			}),
		};

		await expect(runDoorKnockSnapshot(db, provider)).rejects.toThrow('upstream 503');
		expect(inserts).toEqual([]);
	});
});

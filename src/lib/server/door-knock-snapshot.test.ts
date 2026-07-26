import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	runDoorKnockSnapshot,
	openfieldDate,
	perCanvasserRows,
	UNMAPPED_CHAPTER,
} from './door-knock-snapshot.js';
import {
	doorKnockCanvasArchive,
	doorKnockCanvasserDaily,
	doorKnockCodeIds,
	doorKnockDaily,
} from './schema.js';

// Two chapters, two codes — the minimal shape parseConversationCodes accepts
// (a table with a header row and two chapter rows).
const CANVAS = `<table>
<tr><td><p><b>CHAPTER</b></p></td><td><p><b>COUNTIES</b></p></td><td><p><b>CODE</b></p></td></tr>
<tr><td><p>Washtenaw</p></td><td><p>Washtenaw County</p></td><td><p>ZT2H5D</p></td></tr>
<tr><td><p>Wayne</p></td><td><p>Wayne County</p></td><td><p>AB12CD</p></td></tr>
</table>`;

interface CapturedInsert {
	table: unknown;
	values: unknown;
	onConflict: unknown;
}

function makeDb(cachedIdRows: unknown[] = [], prevChapterRows: unknown[] = []) {
	const inserts: CapturedInsert[] = [];
	// Two selects, told apart by shape rather than call order: the code-id
	// cache read awaits `.from()` directly, while the off-canvas last-known-
	// chapter lookup continues `.where().groupBy()`.
	const whereArgs: unknown[] = [];
	const from = vi.fn(() => ({
		then: (r: (v: unknown) => unknown) => Promise.resolve(cachedIdRows).then(r),
		where: (arg: unknown) => {
			whereArgs.push(arg);
			return { groupBy: async () => prevChapterRows };
		},
	}));
	const select = vi.fn(() => ({ from }));
	const all = vi.fn(async () => []);
	const insert = vi.fn((table: unknown) => ({
		values: (values: unknown) => ({
			onConflictDoUpdate: (onConflict: unknown) => {
				inserts.push({ table, values, onConflict });
				return Promise.resolve();
			},
		}),
	}));
	return { db: { select, insert, all } as never, inserts, all, whereArgs };
}

// 02:30 UTC on Jul 7 is 22:30 EDT on Jul 6 — the nightly cron's situation.
const CRON_NOW = () => new Date('2026-07-07T02:30:00Z');

function makeDeps(overrides: Partial<Parameters<typeof runDoorKnockSnapshot>[1]> = {}) {
	return {
		fetchCanvasHtml: async () => CANVAS,
		openfield: {
			resolveCode: vi.fn(async (code: string) => (code === 'ZT2H5D' ? 71 : 72)),
			fetchToday: vi.fn(async (id: number) =>
				id === 71
					? [
							{ canvasser: 'A', attempts: 30, contact: 9 },
							{ canvasser: 'B', attempts: 12, contact: 4 },
						]
					: [],
			),
		},
		now: CRON_NOW,
		...overrides,
	};
}

describe('openfieldDate', () => {
	// Openfield's server rolls over at midnight US Pacific, not Michigan
	// midnight, so a post-ET-midnight run must still stamp the campaign day that
	// just ended (the 12am–3am ET off-by-one that duplicated a day's totals).
	it('uses the US Pacific calendar day (Openfield server rollover)', () => {
		expect(openfieldDate(new Date('2026-07-12T02:00:00Z'))).toBe('2026-07-11'); // 10:00 pm EDT / 7:00 pm PDT
		expect(openfieldDate(new Date('2026-07-12T06:10:00Z'))).toBe('2026-07-11'); // 2:10 am EDT / 11:10 pm PDT — still yesterday
		expect(openfieldDate(new Date('2026-07-12T07:30:00Z'))).toBe('2026-07-12'); // 3:30 am EDT / 12:30 am PDT — rolled over
		expect(openfieldDate(new Date('2026-01-15T07:30:00Z'))).toBe('2026-01-14'); // 2:30 am EST / 11:30 pm PST
	});
});

describe('runDoorKnockSnapshot', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('resolves codes, sums attempts/contacts per code, and upserts dated rows', async () => {
		const { db, inserts } = makeDb();
		const deps = makeDeps();

		const result = await runDoorKnockSnapshot(db, deps);

		expect(result).toEqual({
			date: '2026-07-06',
			codesFound: 2,
			codesResolved: 2,
			codesFailed: [],
			unattributedCodes: [],
			offCanvasCodes: [],
			rowsWritten: 2,
			// ZT2H5D's leaderboard has two canvassers; AB12CD's is empty.
			canvasserRowsWritten: 2,
			totalAttempts: 42,
		});

		// parseConversationCodes returns codes sorted, so AB12CD precedes ZT2H5D.
		const idInserts = inserts.filter((i) => i.table === doorKnockCodeIds);
		expect(idInserts.map((i) => i.values)).toEqual([
			expect.objectContaining({ code: 'AB12CD', conversationId: 72 }),
			expect.objectContaining({ code: 'ZT2H5D', conversationId: 71 }),
		]);

		const dailyInserts = inserts.filter((i) => i.table === doorKnockDaily);
		expect(dailyInserts.map((i) => i.values)).toEqual([
			// Empty leaderboard is a real zero — the row is still written.
			{ date: '2026-07-06', code: 'AB12CD', chapterName: 'Wayne', attempts: 0, contacts: 0 },
			{ date: '2026-07-06', code: 'ZT2H5D', chapterName: 'Washtenaw', attempts: 42, contacts: 13 },
		]);
	});

	it('skips resolution for cached code ids', async () => {
		const { db } = makeDb([
			{ code: 'ZT2H5D', conversationId: 71, resolvedAt: 'x' },
			{ code: 'AB12CD', conversationId: 72, resolvedAt: 'x' },
		]);
		const deps = makeDeps();

		const result = await runDoorKnockSnapshot(db, deps);

		expect(deps.openfield.resolveCode).not.toHaveBeenCalled();
		expect(result.rowsWritten).toBe(2);
	});

	it('reports unresolvable codes as failed without writing rows for them', async () => {
		const { db, inserts } = makeDb();
		const deps = makeDeps();
		deps.openfield.resolveCode = vi.fn(async (code: string) =>
			code === 'ZT2H5D' ? 71 : null,
		);

		const result = await runDoorKnockSnapshot(db, deps);

		expect(result.codesFailed).toEqual(['AB12CD']);
		expect(result.rowsWritten).toBe(1);
		const dailyInserts = inserts.filter((i) => i.table === doorKnockDaily);
		expect(dailyInserts).toHaveLength(1);
	});

	it('a failed leaderboard fetch skips that code but keeps the others', async () => {
		const { db, inserts } = makeDb();
		const deps = makeDeps();
		deps.openfield.fetchToday = vi.fn(async (id: number) => {
			if (id === 72) throw new Error('openfield 503');
			return [{ canvasser: 'A', attempts: 5, contact: 1 }];
		});

		const result = await runDoorKnockSnapshot(db, deps);

		expect(result.codesFailed).toEqual(['AB12CD']);
		expect(result.rowsWritten).toBe(1);
		expect(result.totalAttempts).toBe(5);
		const dailyInserts = inserts.filter((i) => i.table === doorKnockDaily);
		expect(dailyInserts.map((i) => i.values)).toEqual([
			expect.objectContaining({ code: 'ZT2H5D', attempts: 5 }),
		]);
	});

	it('throws when the canvas yields zero codes (moved/restructured canvas)', async () => {
		const { db } = makeDb();
		const deps = makeDeps({ fetchCanvasHtml: async () => '<p>nothing here</p>' });
		await expect(runDoorKnockSnapshot(db, deps)).rejects.toThrow(/no conversation codes/);
	});

	it('archives the canvas HTML per date, even when parsing fails', async () => {
		const { db, inserts } = makeDb();
		await runDoorKnockSnapshot(db, makeDeps());
		let archive = inserts.filter((i) => i.table === doorKnockCanvasArchive);
		expect(archive).toHaveLength(1);
		expect(archive[0]!.values).toMatchObject({ date: '2026-07-06', html: CANVAS });

		// A canvas that breaks the parser still gets archived — that copy is
		// the debugging evidence.
		const { db: db2, inserts: inserts2 } = makeDb();
		await expect(
			runDoorKnockSnapshot(db2, makeDeps({ fetchCanvasHtml: async () => '<p>broken</p>' })),
		).rejects.toThrow();
		archive = inserts2.filter((i) => i.table === doorKnockCanvasArchive);
		expect(archive).toHaveLength(1);
		expect(archive[0]!.values).toMatchObject({ html: '<p>broken</p>' });
	});

	it('counts resolvable codes the parser missed under UNMAPPED_CHAPTER and reports them', async () => {
		const { db, inserts } = makeDb();
		// A code in a bare paragraph (no label separator, no heading) — the
		// structured parser misses it, the candidate scan does not. Plus an
		// ordinary uppercase word that Openfield will reject.
		const deps = makeDeps({
			fetchCanvasHtml: async () =>
				CANVAS + '<p>new code ZZ9ZZ9</p><p>SEE THE COUNTY TABLE ABOVE</p>',
		});
		deps.openfield.resolveCode = vi.fn(async (code: string) => {
			if (code === 'ZT2H5D') return 71;
			if (code === 'AB12CD') return 72;
			if (code === 'ZZ9ZZ9') return 99; // real code the parser missed
			return null; // COUNTY and any other word
		});
		deps.openfield.fetchToday = vi.fn(async (id: number) =>
			id === 99 ? [{ canvasser: 'X', attempts: 7, contact: 2 }] : [],
		);

		const result = await runDoorKnockSnapshot(db, deps);

		expect(result.unattributedCodes).toEqual(['ZZ9ZZ9']);
		// The word is neither unattributed nor failed — expected 404, dropped.
		expect(result.codesFailed).toEqual([]);
		expect(result.codesResolved).toBe(3);
		expect(result.totalAttempts).toBe(7);

		const dailyInserts = inserts.filter((i) => i.table === doorKnockDaily);
		expect(dailyInserts.map((i) => i.values)).toContainEqual({
			date: '2026-07-06',
			code: 'ZZ9ZZ9',
			chapterName: UNMAPPED_CHAPTER,
			attempts: 7,
			contacts: 2,
		});
		expect(deps.openfield.resolveCode).toHaveBeenCalledWith('COUNTY');
	});

	it('counts doors from cached codes that vanished from the canvas (mid-day swap)', async () => {
		// OLD123 was cached on a previous night but is gone from today's canvas;
		// its conversation logged 156 doors this morning. GONE99 also vanished
		// but logged nothing — no row, not reported.
		const { db, inserts } = makeDb(
			[
				{ code: 'ZT2H5D', conversationId: 71, resolvedAt: 'x' },
				{ code: 'AB12CD', conversationId: 72, resolvedAt: 'x' },
				{ code: 'OLD123', conversationId: 88, resolvedAt: 'x' },
				{ code: 'GONE99', conversationId: 89, resolvedAt: 'x' },
			],
			[{ code: 'OLD123', chapterName: 'Kent' }],
		);
		const deps = makeDeps();
		deps.openfield.fetchToday = vi.fn(async (id: number) => {
			if (id === 88) return [{ canvasser: 'M', attempts: 156, contact: 30 }];
			if (id === 71) return [{ canvasser: 'A', attempts: 10, contact: 2 }];
			return [];
		});

		const result = await runDoorKnockSnapshot(db, deps);

		expect(result.offCanvasCodes).toEqual(['OLD123']);
		expect(result.totalAttempts).toBe(166);
		const dailyInserts = inserts.filter((i) => i.table === doorKnockDaily);
		expect(dailyInserts.map((i) => i.values)).toContainEqual({
			date: '2026-07-06',
			code: 'OLD123',
			chapterName: 'Kent',
			attempts: 156,
			contacts: 30,
		});
		expect(dailyInserts.map((i) => i.values)).not.toContainEqual(
			expect.objectContaining({ code: 'GONE99' }),
		);
	});

	it('off-canvas codes with no chapter history land under UNMAPPED_CHAPTER', async () => {
		const { db, inserts } = makeDb(
			[
				{ code: 'ZT2H5D', conversationId: 71, resolvedAt: 'x' },
				{ code: 'AB12CD', conversationId: 72, resolvedAt: 'x' },
				{ code: 'OLD123', conversationId: 88, resolvedAt: 'x' },
			],
			[], // no previous daily rows for OLD123
		);
		const deps = makeDeps();
		deps.openfield.fetchToday = vi.fn(async (id: number) =>
			id === 88 ? [{ canvasser: 'M', attempts: 9, contact: 1 }] : [],
		);

		const result = await runDoorKnockSnapshot(db, deps);

		expect(result.offCanvasCodes).toEqual(['OLD123']);
		const dailyInserts = inserts.filter((i) => i.table === doorKnockDaily);
		expect(dailyInserts.map((i) => i.values)).toContainEqual(
			expect.objectContaining({ code: 'OLD123', chapterName: UNMAPPED_CHAPTER }),
		);
	});
});

describe('perCanvasserRows', () => {
	it('keeps one row per named canvasser', () => {
		expect(
			perCanvasserRows('ZT2H5D', [
				{ canvasser: 'Maria T.', attempts: 30, contact: 9 },
				{ canvasser: 'James R.', attempts: 12, contact: 4 },
			]),
		).toEqual([
			{ code: 'ZT2H5D', canvasser: 'Maria T.', attempts: 30, contacts: 9 },
			{ code: 'ZT2H5D', canvasser: 'James R.', attempts: 12, contacts: 4 },
		]);
	});

	it('trims names so spacing differences do not split a person in two', () => {
		expect(perCanvasserRows('AB12CD', [{ canvasser: '  Ada L. ', attempts: 5, contact: 1 }])).toEqual(
			[{ code: 'AB12CD', canvasser: 'Ada L.', attempts: 5, contacts: 1 }],
		);
	});

	// '' would collide on the (date, code, canvasser) primary key and has
	// nothing to show on a ticker anyway.
	it('drops unnamed rows', () => {
		expect(
			perCanvasserRows('AB12CD', [
				{ canvasser: '', attempts: 9, contact: 2 },
				{ canvasser: '   ', attempts: 4, contact: 0 },
			]),
		).toEqual([]);
	});

	it('merges a name that appears twice rather than letting the rows collide', () => {
		expect(
			perCanvasserRows('AB12CD', [
				{ canvasser: 'Ada L.', attempts: 5, contact: 1 },
				{ canvasser: 'Ada L.', attempts: 7, contact: 3 },
			]),
		).toEqual([{ code: 'AB12CD', canvasser: 'Ada L.', attempts: 12, contacts: 4 }]);
	});
});

describe('runDoorKnockSnapshot canvasser capture', () => {
	it('writes a dated row per person alongside the per-code totals', async () => {
		const { db, inserts } = makeDb();

		await runDoorKnockSnapshot(db, makeDeps());

		const canvasserInserts = inserts.filter((i) => i.table === doorKnockCanvasserDaily);
		expect(canvasserInserts.map((i) => i.values)).toEqual([
			{ date: '2026-07-06', code: 'ZT2H5D', canvasser: 'A', attempts: 30, contacts: 9 },
			{ date: '2026-07-06', code: 'ZT2H5D', canvasser: 'B', attempts: 12, contacts: 4 },
		]);
	});

	// Doors knocked under a code that was swapped out mid-day still belong to
	// the person who knocked them.
	it('captures canvassers on off-canvas codes too', async () => {
		const { db, inserts } = makeDb(
			[
				{ code: 'ZT2H5D', conversationId: 71, resolvedAt: 'x' },
				{ code: 'AB12CD', conversationId: 72, resolvedAt: 'x' },
				{ code: 'OLD123', conversationId: 88, resolvedAt: 'x' },
			],
			[{ code: 'OLD123', chapterName: 'Kent' }],
		);
		const deps = makeDeps();
		deps.openfield.fetchToday = vi.fn(async (id: number) =>
			id === 88 ? [{ canvasser: 'Maria T.', attempts: 156, contact: 30 }] : [],
		);

		await runDoorKnockSnapshot(db, deps);

		const canvasserInserts = inserts.filter((i) => i.table === doorKnockCanvasserDaily);
		expect(canvasserInserts.map((i) => i.values)).toEqual([
			{ date: '2026-07-06', code: 'OLD123', canvasser: 'Maria T.', attempts: 156, contacts: 30 },
		]);
	});

	it('writes nothing when no conversation reported a named canvasser', async () => {
		const { db, inserts } = makeDb();
		const deps = makeDeps();
		deps.openfield.fetchToday = vi.fn(async () => []);

		const result = await runDoorKnockSnapshot(db, deps);

		expect(result.canvasserRowsWritten).toBe(0);
		expect(inserts.filter((i) => i.table === doorKnockCanvasserDaily)).toEqual([]);
	});
});

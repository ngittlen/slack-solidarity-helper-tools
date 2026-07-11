import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDoorKnockSnapshot, detroitDate, UNMAPPED_CHAPTER } from './door-knock-snapshot.js';
import { doorKnockCodeIds, doorKnockDaily } from './schema.js';

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

function makeDb(cachedIdRows: unknown[] = []) {
	const inserts: CapturedInsert[] = [];
	const where = vi.fn().mockResolvedValue(cachedIdRows);
	const from = vi.fn(() => ({ where }));
	const select = vi.fn(() => ({ from }));
	const insert = vi.fn((table: unknown) => ({
		values: (values: unknown) => ({
			onConflictDoUpdate: (onConflict: unknown) => {
				inserts.push({ table, values, onConflict });
				return Promise.resolve();
			},
		}),
	}));
	return { db: { select, insert } as never, inserts };
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

describe('detroitDate', () => {
	it('uses the Michigan calendar day, not UTC', () => {
		expect(detroitDate(new Date('2026-07-07T02:30:00Z'))).toBe('2026-07-06'); // 22:30 EDT
		expect(detroitDate(new Date('2026-07-07T12:00:00Z'))).toBe('2026-07-07'); // 08:00 EDT
		expect(detroitDate(new Date('2026-01-15T04:30:00Z'))).toBe('2026-01-14'); // 23:30 EST
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
			rowsWritten: 2,
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
});

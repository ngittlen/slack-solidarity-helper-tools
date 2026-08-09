import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCanvasWatcher, type CanvasWatcherDeps } from './canvas-watch.js';
import { doorKnockCanvasArchive, doorKnockCodeIds } from '$lib/server/schema.js';

// Minimal canvas: one chapter table row per code.
function canvasWith(...codes: string[]): string {
	const rows = codes
		.map(
			(code, i) =>
				`<tr><td><p>Chapter ${i + 1}</p></td><td><p>County</p></td><td><p>${code}</p></td></tr>`,
		)
		.join('');
	return `<table><tr><td><p><b>CHAPTER</b></p></td><td><p><b>COUNTIES</b></p></td><td><p><b>CODE</b></p></td></tr>${rows}</table>`;
}

function makeDb(cachedIdRows: unknown[] = []) {
	const inserts: Array<{ table: unknown; values: unknown }> = [];
	const from = vi.fn().mockResolvedValue(cachedIdRows);
	const select = vi.fn(() => ({ from }));
	const insert = vi.fn((table: unknown) => ({
		values: (values: unknown) => ({
			onConflictDoUpdate: () => {
				inserts.push({ table, values });
				return Promise.resolve();
			},
		}),
	}));
	return { db: { select, insert } as never, inserts };
}

const NOW = () => new Date('2026-07-10T20:00:00Z');

function makeWatcher(opts: { current: string; cached?: unknown[]; fileId?: string }) {
	const { db, inserts } = makeDb(opts.cached ?? []);
	const deps: CanvasWatcherDeps = {
		db,
		findCanvasFileId: vi.fn(async () => opts.fileId ?? 'F_CODES'),
		fetchCanvasHtml: vi.fn(async () => opts.current),
		openfield: { resolveCode: vi.fn(async () => 1230) },
		debounceMs: 5,
		now: NOW,
	};
	return { watcher: createCanvasWatcher(deps), deps, inserts };
}

describe('createCanvasWatcher', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('ignores file_change events for other files without fetching the canvas', async () => {
		const { watcher, deps } = makeWatcher({ current: canvasWith('AB12CD') });
		await watcher.handleFileChange('F_SOMETHING_ELSE');
		await new Promise((r) => setTimeout(r, 20));
		expect(deps.fetchCanvasHtml).not.toHaveBeenCalled();
	});

	it('caches the canvas file id lookup across events', async () => {
		const { watcher, deps } = makeWatcher({ current: canvasWith('AB12CD') });
		await watcher.handleFileChange('F_OTHER1');
		await watcher.handleFileChange('F_OTHER2');
		expect(deps.findCanvasFileId).toHaveBeenCalledTimes(1);
	});

	it('debounces an edit burst into a single check', async () => {
		const { watcher, deps } = makeWatcher({ current: canvasWith('AB12CD') });
		await watcher.handleFileChange('F_CODES');
		await watcher.handleFileChange('F_CODES');
		await watcher.handleFileChange('F_CODES');
		await new Promise((r) => setTimeout(r, 30));
		expect(deps.fetchCanvasHtml).toHaveBeenCalledTimes(1);
	});

	it('resolves and caches codes it has not seen before', async () => {
		const { watcher, deps, inserts } = makeWatcher({
			current: canvasWith('AB12CD', 'NEW111'),
			cached: [{ code: 'AB12CD', conversationId: 72, resolvedAt: 'x' }],
		});
		await watcher._runCheckNow();

		// Only the unseen code gets resolved and written to the cache table —
		// this is what lets the nightly snapshot count it even if it's swapped
		// off the canvas later today.
		expect(deps.openfield.resolveCode).toHaveBeenCalledTimes(1);
		expect(deps.openfield.resolveCode).toHaveBeenCalledWith('NEW111');
		const idInserts = inserts.filter((i) => i.table === doorKnockCodeIds);
		expect(idInserts.map((i) => i.values)).toEqual([
			expect.objectContaining({ code: 'NEW111', conversationId: 1230 }),
		]);
	});

	it('refreshes the daily archive on every check', async () => {
		const { watcher, inserts } = makeWatcher({
			current: canvasWith('AB12CD'),
			cached: [{ code: 'AB12CD', conversationId: 72, resolvedAt: 'x' }],
		});
		await watcher._runCheckNow();
		const archiveInserts = inserts.filter((i) => i.table === doorKnockCanvasArchive);
		expect(archiveInserts).toHaveLength(1);
		expect(archiveInserts[0]!.values).toMatchObject({
			date: '2026-07-10',
			html: canvasWith('AB12CD'),
		});
	});

	it('does nothing beyond the archive when every code is already cached', async () => {
		const { watcher, deps, inserts } = makeWatcher({
			current: canvasWith('AB12CD'),
			cached: [{ code: 'AB12CD', conversationId: 72, resolvedAt: 'x' }],
		});
		await watcher._runCheckNow();
		expect(deps.openfield.resolveCode).not.toHaveBeenCalled();
		expect(inserts.filter((i) => i.table === doorKnockCodeIds)).toHaveLength(0);
	});

	it('survives a fetch failure without throwing', async () => {
		const { watcher, deps } = makeWatcher({ current: canvasWith('AB12CD') });
		deps.fetchCanvasHtml = vi.fn(async () => {
			throw new Error('slack down');
		});
		await expect(watcher._runCheckNow()).resolves.toBeUndefined();
		expect(deps.openfield.resolveCode).not.toHaveBeenCalled();
	});
});

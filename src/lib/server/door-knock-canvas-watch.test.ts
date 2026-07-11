import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCanvasWatcher, type CanvasWatcherDeps } from './door-knock-canvas-watch.js';
import { doorKnockCanvasArchive } from './schema.js';

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

interface MockDb {
	db: CanvasWatcherDeps['db'];
	inserts: Array<{ table: unknown; values: unknown }>;
}

function makeDb(latestArchiveHtml: string | null): MockDb {
	const inserts: Array<{ table: unknown; values: unknown }> = [];
	const rows = latestArchiveHtml === null ? [] : [{ date: '2026-07-09', html: latestArchiveHtml, fetchedAt: 'x' }];
	const limit = vi.fn().mockResolvedValue(rows);
	const orderBy = vi.fn(() => ({ limit }));
	const from = vi.fn(() => ({ orderBy }));
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

function makeWatcher(opts: {
	archived: string | null;
	current: string;
	fileId?: string;
}) {
	const { db, inserts } = makeDb(opts.archived);
	const deps: CanvasWatcherDeps = {
		db,
		findCanvasFileId: vi.fn(async () => opts.fileId ?? 'F_CODES'),
		fetchCanvasHtml: vi.fn(async () => opts.current),
		postNotification: vi.fn(async () => {}),
		debounceMs: 5,
		now: NOW,
	};
	return { watcher: createCanvasWatcher(deps), deps, inserts };
}

describe('createCanvasWatcher', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('ignores file_change events for other files without fetching the canvas', async () => {
		const { watcher, deps } = makeWatcher({ archived: null, current: canvasWith('AB12CD') });
		await watcher.handleFileChange('F_SOMETHING_ELSE');
		await new Promise((r) => setTimeout(r, 20));
		expect(deps.fetchCanvasHtml).not.toHaveBeenCalled();
	});

	it('caches the canvas file id lookup across events', async () => {
		const { watcher, deps } = makeWatcher({ archived: null, current: canvasWith('AB12CD') });
		await watcher.handleFileChange('F_OTHER1');
		await watcher.handleFileChange('F_OTHER2');
		expect(deps.findCanvasFileId).toHaveBeenCalledTimes(1);
	});

	it('debounces an edit burst into a single check', async () => {
		const { watcher, deps } = makeWatcher({ archived: null, current: canvasWith('AB12CD') });
		await watcher.handleFileChange('F_CODES');
		await watcher.handleFileChange('F_CODES');
		await watcher.handleFileChange('F_CODES');
		await new Promise((r) => setTimeout(r, 30));
		expect(deps.fetchCanvasHtml).toHaveBeenCalledTimes(1);
	});

	it('notifies with added and removed codes when the code set changes', async () => {
		const { watcher, deps, inserts } = makeWatcher({
			archived: canvasWith('AB12CD', 'OLD999'),
			current: canvasWith('AB12CD', 'NEW111'),
		});
		await watcher._runCheckNow();

		expect(deps.postNotification).toHaveBeenCalledTimes(1);
		const text = (deps.postNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
		expect(text).toContain('added NEW111');
		expect(text).toContain('removed OLD999');

		// The archive is refreshed so the next diff runs against this state.
		const archiveInserts = inserts.filter((i) => i.table === doorKnockCanvasArchive);
		expect(archiveInserts).toHaveLength(1);
		expect(archiveInserts[0]!.values).toMatchObject({
			date: '2026-07-10',
			html: canvasWith('AB12CD', 'NEW111'),
		});
	});

	it('stays silent on text-only changes but still refreshes the archive', async () => {
		const { watcher, deps, inserts } = makeWatcher({
			archived: canvasWith('AB12CD') + '<p>old note</p>',
			current: canvasWith('AB12CD') + '<p>new note</p>',
		});
		await watcher._runCheckNow();
		expect(deps.postNotification).not.toHaveBeenCalled();
		expect(inserts.filter((i) => i.table === doorKnockCanvasArchive)).toHaveLength(1);
	});

	it('stays silent on the first sighting (nothing to diff against)', async () => {
		const { watcher, deps, inserts } = makeWatcher({
			archived: null,
			current: canvasWith('AB12CD'),
		});
		await watcher._runCheckNow();
		expect(deps.postNotification).not.toHaveBeenCalled();
		expect(inserts.filter((i) => i.table === doorKnockCanvasArchive)).toHaveLength(1);
	});

	it('survives a fetch failure without throwing', async () => {
		const { watcher, deps } = makeWatcher({ archived: null, current: canvasWith('AB12CD') });
		deps.fetchCanvasHtml = vi.fn(async () => {
			throw new Error('slack down');
		});
		await expect(watcher._runCheckNow()).resolves.toBeUndefined();
		expect(deps.postNotification).not.toHaveBeenCalled();
	});
});

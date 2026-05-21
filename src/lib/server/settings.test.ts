import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// env.ts is mocked per-test. Modeled on the chained-db pattern in
// dashboard-signups.test.ts:35–67 — a `makeDb()` factory whose `select` chain
// pulls rows from a queue and whose `insert`/`delete` chains record what they
// were called with into capturable arrays.
vi.mock('./env.js', () => ({
	SOLIDARITY_CHAPTER_CHANNEL_MAP: [
		{ chapterId: 1, channelId: 'C_ENV_CHAP', name: 'Env Chapter' },
	],
	COALITION_CHANNEL_MAP: { labor: 'C_ENV_LABOR' },
	SLACK_ALLOWED_USER_IDS: new Set(['U_ENV_ALICE']),
	REPORT_EXCLUDED_CHAPTER_IDS: new Set([99]),
	SLACK_TRACKING_CHANNEL_ID: 'C_ENV_TRACK',
	SLACK_GROWTH_REPORT_CHANNEL_ID: 'C_ENV_GROWTH',
	SLACK_GROWTH_REPORT_RANKING_ALPHA: 0.5,
}));

import {
	loadSettings,
	saveChapterChannelEntry,
	deleteChapterChannelEntry,
	saveCoalitionEntry,
	deleteCoalitionEntry,
	saveAllowedUser,
	deleteAllowedUser,
	saveExcludedChapter,
	deleteExcludedChapter,
	saveAppConfig,
	chapterChannelMap,
	coalitionChannelMap,
	allowedSlackUsers,
	reportExcludedChapters,
	appConfig,
} from './settings.js';

interface CapturedInsert {
	table: unknown;
	values: unknown;
	onConflict: unknown;
}

interface CapturedDelete {
	table: unknown;
	where: unknown;
}

interface MockDb {
	select: ReturnType<typeof vi.fn>;
	insert: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
	_pushSelect: (rows: unknown[]) => void;
	_capturedInserts: () => CapturedInsert[];
	_capturedDeletes: () => CapturedDelete[];
}

function makeDb(): MockDb {
	const selectQueue: unknown[][] = [];
	const inserts: CapturedInsert[] = [];
	const deletes: CapturedDelete[] = [];

	const select = vi.fn(() => {
		const rows = selectQueue.shift() ?? [];
		const limit = vi.fn().mockResolvedValue(rows);
		const from = vi.fn(() => ({
			limit,
			then: (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r),
		}));
		return { from };
	});

	const insert = vi.fn((table: unknown) => ({
		values: (values: unknown) => ({
			onConflictDoUpdate: async (onConflict: unknown) => {
				inserts.push({ table, values, onConflict });
			},
		}),
	}));

	const del = vi.fn((table: unknown) => ({
		where: async (where: unknown) => {
			deletes.push({ table, where });
		},
	}));

	return {
		select,
		insert,
		delete: del,
		_pushSelect: (rows) => selectQueue.push(rows),
		_capturedInserts: () => inserts,
		_capturedDeletes: () => deletes,
	};
}

// `loadSettings` always issues five reads, in this exact order: chapter,
// coalition, allowed users, excluded chapters, app_config.
function pushAllEmpty(db: MockDb) {
	for (let i = 0; i < 5; i++) db._pushSelect([]);
}

describe('loadSettings — Story 1 (env fallback when tables are empty)', () => {
	it('returns env values for every field when all five tables are empty', async () => {
		const db = makeDb();
		pushAllEmpty(db);

		const result = await loadSettings(db as never);

		expect(result.chapterChannelMap).toEqual([
			{ chapterId: 1, channelId: 'C_ENV_CHAP', name: 'Env Chapter' },
		]);
		expect(result.coalitionChannelMap).toEqual({ labor: 'C_ENV_LABOR' });
		expect(result.allowedSlackUserIds).toEqual(new Set(['U_ENV_ALICE']));
		expect(result.reportExcludedChapterIds).toEqual(new Set([99]));
		expect(result.slackTrackingChannelId).toBe('C_ENV_TRACK');
		expect(result.slackGrowthReportChannelId).toBe('C_ENV_GROWTH');
		expect(result.slackGrowthReportRankingAlpha).toBe(0.5);
	});

	it('returns defensive defaults when env vars are unset and tables are empty', async () => {
		// Re-mock env.js with the empty-state shapes for just this test.
		vi.doMock('./env.js', () => ({
			SOLIDARITY_CHAPTER_CHANNEL_MAP: [],
			COALITION_CHANNEL_MAP: {},
			SLACK_ALLOWED_USER_IDS: new Set<string>(),
			REPORT_EXCLUDED_CHAPTER_IDS: new Set<number>(),
			SLACK_TRACKING_CHANNEL_ID: '',
			SLACK_GROWTH_REPORT_CHANNEL_ID: '',
			SLACK_GROWTH_REPORT_RANKING_ALPHA: undefined,
		}));
		vi.resetModules();
		const { loadSettings: loadFresh } = await import('./settings.js');

		const db = makeDb();
		pushAllEmpty(db);

		const result = await loadFresh(db as never);

		expect(result).toEqual({
			chapterChannelMap: [],
			coalitionChannelMap: {},
			allowedSlackUserIds: new Set(),
			reportExcludedChapterIds: new Set(),
			slackTrackingChannelId: '',
			slackGrowthReportChannelId: '',
			slackGrowthReportRankingAlpha: undefined,
		});

		// Restore the module-level mock for subsequent tests.
		vi.doUnmock('./env.js');
		vi.resetModules();
	});

	it('does not re-parse env on each call — imports the already-parsed constants', async () => {
		// The env module exposes constants, not functions. Calling loadSettings
		// twice must not produce two different env-parse passes; both calls see the
		// same imported reference. We assert this by checking that the array
		// reference returned for chapterChannelMap (env-fallback path) is the same
		// across two calls.
		const db1 = makeDb();
		pushAllEmpty(db1);
		const result1 = await loadSettings(db1 as never);

		const db2 = makeDb();
		pushAllEmpty(db2);
		const result2 = await loadSettings(db2 as never);

		expect(result1.chapterChannelMap).toBe(result2.chapterChannelMap);
		expect(result1.coalitionChannelMap).toBe(result2.coalitionChannelMap);
		expect(result1.allowedSlackUserIds).toBe(result2.allowedSlackUserIds);
		expect(result1.reportExcludedChapterIds).toBe(result2.reportExcludedChapterIds);
	});
});

describe('loadSettings — Story 2 (typed contract under DB-override)', () => {
	it('DB rows override env for chapterChannelMap', async () => {
		const db = makeDb();
		db._pushSelect([
			{
				chapterId: 7,
				channelId: 'C_DB_CHAP',
				name: 'DB Chapter',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);

		expect(result.chapterChannelMap).toEqual([
			{ chapterId: 7, channelId: 'C_DB_CHAP', name: 'DB Chapter' },
		]);
		// Other multi-row fields fall back to env, confirming table-level shadow is scoped.
		expect(result.coalitionChannelMap).toEqual({ labor: 'C_ENV_LABOR' });
	});

	it('DB rows override env for coalitionChannelMap', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([
			{
				groupName: 'housing',
				channelId: 'C_DB_HOUS',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);
		expect(result.coalitionChannelMap).toEqual({ housing: 'C_DB_HOUS' });
	});

	it('DB rows override env for allowedSlackUserIds', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([
			{
				slackUserId: 'U_DB_BOB',
				displayName: 'Bob',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);
		db._pushSelect([]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);
		expect(result.allowedSlackUserIds).toEqual(new Set(['U_DB_BOB']));
	});

	it('DB rows override env for reportExcludedChapterIds', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([
			{
				chapterId: 42,
				reason: 'test chapter',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);
		expect(result.reportExcludedChapterIds).toEqual(new Set([42]));
	});

	it('app_config row with one populated field uses DB for that field and env for the other two NULLs', async () => {
		const db = makeDb();
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([
			{
				id: 1,
				slackTrackingChannelId: 'C_DB_TRACK',
				slackGrowthReportChannelId: null,
				slackGrowthReportRankingAlpha: null,
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);

		const result = await loadSettings(db as never);
		expect(result.slackTrackingChannelId).toBe('C_DB_TRACK');
		expect(result.slackGrowthReportChannelId).toBe('C_ENV_GROWTH');
		expect(result.slackGrowthReportRankingAlpha).toBe(0.5);
	});

	it('bundle has exactly the seven documented keys', async () => {
		const db = makeDb();
		pushAllEmpty(db);
		const result = await loadSettings(db as never);
		expect(Object.keys(result).sort()).toEqual(
			[
				'allowedSlackUserIds',
				'chapterChannelMap',
				'coalitionChannelMap',
				'reportExcludedChapterIds',
				'slackGrowthReportChannelId',
				'slackGrowthReportRankingAlpha',
				'slackTrackingChannelId',
			].sort(),
		);
	});

	it('no module-level cache — two calls each hit the DB (5 reads × 2 = 10)', async () => {
		const db = makeDb();
		pushAllEmpty(db);
		pushAllEmpty(db);

		await loadSettings(db as never);
		await loadSettings(db as never);

		expect(db.select).toHaveBeenCalledTimes(10);
	});

	it('chapter row shape matches ChapterEntry — keys chapterId/channelId/name', async () => {
		const db = makeDb();
		db._pushSelect([
			{
				chapterId: 5,
				channelId: 'C_DB_CHAP',
				name: 'Some Chapter',
				lastEditedBy: 'U_X',
				lastEditedByName: 'X',
				lastEditedAt: '2026-05-17T00:00:00.000Z',
			},
		]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);
		const [entry] = result.chapterChannelMap;
		expect(Object.keys(entry!).sort()).toEqual(['channelId', 'chapterId', 'name']);
		expect(typeof entry!.chapterId).toBe('number');
		expect(typeof entry!.channelId).toBe('string');
		expect(typeof entry!.name).toBe('string');
	});
});

describe('settings setters — Story 3', () => {
	const editor = { id: 'U_ALICE', name: 'Alice' };
	const FROZEN = new Date('2026-05-17T12:00:00.000Z');

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(FROZEN);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('saveChapterChannelEntry writes payload + audit columns and emits [settings] log', async () => {
		const db = makeDb();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveChapterChannelEntry(
			db as never,
			{ chapterId: 7, channelId: 'C_X', name: 'Seven' },
			editor,
		);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(chapterChannelMap);
		expect(captured!.values).toMatchObject({
			chapterId: 7,
			channelId: 'C_X',
			name: 'Seven',
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		const onConflict = captured!.onConflict as { target: unknown; set: Record<string, unknown> };
		expect(onConflict.target).toBe(chapterChannelMap.chapterId);
		expect(onConflict.set).toMatchObject({
			channelId: 'C_X',
			name: 'Seven',
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(/^\[settings\] saved chapter_channel_map .*U_ALICE.*Alice/),
		);
	});

	it('saveCoalitionEntry writes payload + audit columns', async () => {
		const db = makeDb();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveCoalitionEntry(db as never, { group: 'labor', channelId: 'C_L' }, editor);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(coalitionChannelMap);
		expect(captured!.values).toMatchObject({
			groupName: 'labor',
			channelId: 'C_L',
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		const onConflict = captured!.onConflict as { target: unknown; set: Record<string, unknown> };
		expect(onConflict.target).toBe(coalitionChannelMap.groupName);
		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(/^\[settings\] saved coalition_channel_map .*U_ALICE/),
		);
	});

	it('saveAllowedUser writes payload + audit columns', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveAllowedUser(
			db as never,
			{ slackUserId: 'U_BOB', displayName: 'Bob' },
			editor,
		);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(allowedSlackUsers);
		expect(captured!.values).toMatchObject({
			slackUserId: 'U_BOB',
			displayName: 'Bob',
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		const onConflict = captured!.onConflict as { target: unknown };
		expect(onConflict.target).toBe(allowedSlackUsers.slackUserId);
	});

	it('saveExcludedChapter writes payload (with explicit null reason when omitted)', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveExcludedChapter(db as never, { chapterId: 99 }, editor);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(reportExcludedChapters);
		expect(captured!.values).toMatchObject({
			chapterId: 99,
			reason: null,
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		const onConflict = captured!.onConflict as { target: unknown };
		expect(onConflict.target).toBe(reportExcludedChapters.chapterId);
	});

	it('saveExcludedChapter forwards a provided reason verbatim', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveExcludedChapter(
			db as never,
			{ chapterId: 99, reason: 'internal-only' },
			editor,
		);

		const [captured] = db._capturedInserts();
		expect((captured!.values as { reason: string }).reason).toBe('internal-only');
	});

	it('delete setters call db.delete(table).where(eq(<pk>, key)) and log success', async () => {
		const db = makeDb();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		await deleteChapterChannelEntry(db as never, 7, editor);
		await deleteCoalitionEntry(db as never, 'labor', editor);
		await deleteAllowedUser(db as never, 'U_BOB', editor);
		await deleteExcludedChapter(db as never, 99, editor);

		const captured = db._capturedDeletes();
		expect(captured).toHaveLength(4);
		expect(captured[0]!.table).toBe(chapterChannelMap);
		expect(captured[1]!.table).toBe(coalitionChannelMap);
		expect(captured[2]!.table).toBe(allowedSlackUsers);
		expect(captured[3]!.table).toBe(reportExcludedChapters);

		// Spot-check that the `where` arg references the PK column and key value.
		// Drizzle's `eq` returns an SQL object whose serialization carries the column
		// and value — we stringify with a WeakSet-based replacer (circular refs).
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
		expect(safeStringify(captured[0]!.where)).toContain('chapter_id');
		expect(safeStringify(captured[0]!.where)).toContain('7');
		expect(safeStringify(captured[1]!.where)).toContain('group_name');
		expect(safeStringify(captured[1]!.where)).toContain('labor');

		// All four delete log lines fired.
		const lines = log.mock.calls.map((c) => String(c[0]));
		expect(lines).toHaveLength(4);
		for (const line of lines) {
			expect(line).toMatch(/^\[settings\] deleted .*U_ALICE.*Alice/);
		}
	});

	it('saveAppConfig rejects unknown patch keys synchronously (before any DB call)', async () => {
		const db = makeDb();
		await expect(
			saveAppConfig(db as never, { someUnknownKey: 'x' } as never, editor),
		).rejects.toThrow(/unknown patch key "someUnknownKey"/);
		expect(db.insert).not.toHaveBeenCalled();
	});

	it('saveAppConfig partial patch builds a set clause containing only the present keys + audit', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveAppConfig(db as never, { slackTrackingChannelId: 'C_X' }, editor);

		const [captured] = db._capturedInserts();
		expect(captured!.table).toBe(appConfig);
		expect(captured!.values).toMatchObject({
			id: 1,
			slackTrackingChannelId: 'C_X',
			lastEditedBy: 'U_ALICE',
			lastEditedByName: 'Alice',
			lastEditedAt: FROZEN.toISOString(),
		});
		const onConflict = captured!.onConflict as { target: unknown; set: Record<string, unknown> };
		expect(onConflict.target).toBe(appConfig.id);
		expect(Object.keys(onConflict.set).sort()).toEqual([
			'lastEditedAt',
			'lastEditedBy',
			'lastEditedByName',
			'slackTrackingChannelId',
		]);
		expect(onConflict.set).not.toHaveProperty('slackGrowthReportChannelId');
		expect(onConflict.set).not.toHaveProperty('slackGrowthReportRankingAlpha');
	});

	it('saveAppConfig treats null and undefined patch values as ABSENT (set-only contract)', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveAppConfig(
			db as never,
			{
				slackTrackingChannelId: 'C_X',
				slackGrowthReportChannelId: null as never,
				slackGrowthReportRankingAlpha: undefined,
			},
			editor,
		);

		const [captured] = db._capturedInserts();
		expect(captured!.values).not.toHaveProperty('slackGrowthReportChannelId');
		expect(captured!.values).not.toHaveProperty('slackGrowthReportRankingAlpha');
		const onConflict = captured!.onConflict as { set: Record<string, unknown> };
		expect(onConflict.set).not.toHaveProperty('slackGrowthReportChannelId');
		expect(onConflict.set).not.toHaveProperty('slackGrowthReportRankingAlpha');
	});

	it('saveAppConfig emits the [settings] log line with comma-separated patch keys', async () => {
		const db = makeDb();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveAppConfig(
			db as never,
			{ slackTrackingChannelId: 'C_X', slackGrowthReportChannelId: 'C_Y' },
			editor,
		);

		expect(log).toHaveBeenCalledWith(
			expect.stringMatching(
				/^\[settings\] saved app_config patch=.*slackTrackingChannelId.*slackGrowthReportChannelId.*by U_ALICE \(Alice\)/,
			),
		);
	});

	it('round-trip: after a save, the next loadSettings returns the new value', async () => {
		const db = makeDb();
		vi.spyOn(console, 'log').mockImplementation(() => {});

		await saveChapterChannelEntry(
			db as never,
			{ chapterId: 11, channelId: 'C_NEW', name: 'New' },
			editor,
		);

		// Pre-queue the rows the next loadSettings will read — chapter row reflects
		// the save, the other four tables are empty.
		db._pushSelect([
			{
				chapterId: 11,
				channelId: 'C_NEW',
				name: 'New',
				lastEditedBy: 'U_ALICE',
				lastEditedByName: 'Alice',
				lastEditedAt: FROZEN.toISOString(),
			},
		]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);
		db._pushSelect([]);

		const result = await loadSettings(db as never);
		expect(result.chapterChannelMap).toEqual([
			{ chapterId: 11, channelId: 'C_NEW', name: 'New' },
		]);
	});
});

describe('app_config singleton CHECK constraint — Story 3 (FR-022)', () => {
	it('rejects a second insert against an in-memory libSQL with the real migration', async () => {
		const { createClient } = await import('@libsql/client');
		const fs = await import('node:fs');
		const path = await import('node:path');

		// Discover the migration filename — the auto-slug picked by drizzle-kit
		// generate is non-deterministic, so anyone regenerating gets a new slug.
		const drizzleDir = path.resolve('drizzle');
		const file = fs
			.readdirSync(drizzleDir)
			.find((f) => f.startsWith('0005_') && f.endsWith('.sql'));
		expect(file).toBeDefined();
		const sqlText = fs.readFileSync(path.join(drizzleDir, file!), 'utf-8');

		const client = createClient({ url: ':memory:' });
		try {
			await client.executeMultiple(sqlText);

			await client.execute({
				sql: 'INSERT INTO app_config (id, last_edited_by, last_edited_by_name, last_edited_at) VALUES (?, ?, ?, ?)',
				args: [1, 'U_X', 'X', '2026-05-17T00:00:00.000Z'],
			});

			await expect(
				client.execute({
					sql: 'INSERT INTO app_config (id, last_edited_by, last_edited_by_name, last_edited_at) VALUES (?, ?, ?, ?)',
					args: [2, 'U_Y', 'Y', '2026-05-17T00:00:01.000Z'],
				}),
			).rejects.toThrow();
		} finally {
			client.close();
		}
	});
});

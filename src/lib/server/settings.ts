// Settings storage seam for the admin settings page (NAV-3 through NAV-9).
// One typed `loadSettings(db)` that reads the five settings tables, plus
// per-table setters that stamp the audit columns and log the action. The
// coalition channel map lives only in the DB (edited on /settings); the
// remaining fields fall back to env when their row(s) are absent.
//
// See specs/005-settings-storage-loader/contracts/settings-module.md for the
// full contract.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';

import {
	chapterChannelMap,
	coalitionChannelMap,
	allowedSlackUsers,
	reportExcludedChapters,
	channelWelcomeFlags,
	appConfig,
} from './schema.js';
import {
	SOLIDARITY_CHAPTER_CHANNEL_MAP,
	SLACK_ALLOWED_USER_IDS,
	REPORT_EXCLUDED_CHAPTER_IDS,
	SLACK_TRACKING_CHANNEL_ID,
	SLACK_GROWTH_REPORT_CHANNEL_ID,
	SLACK_GROWTH_REPORT_RANKING_ALPHA,
} from './env.js';
import { clampTickerColumnsPerSecond } from '../ticker-speed.js';

export {
	chapterChannelMap,
	coalitionChannelMap,
	allowedSlackUsers,
	reportExcludedChapters,
	channelWelcomeFlags,
	appConfig,
};

export type {
	ChapterChannelRow,
	NewChapterChannelRow,
	CoalitionChannelRow,
	NewCoalitionChannelRow,
	AllowedSlackUserRow,
	NewAllowedSlackUserRow,
	ExcludedChapterRow,
	NewExcludedChapterRow,
	AppConfigRow,
	NewAppConfigRow,
} from './schema.js';

type Database = ReturnType<typeof drizzle>;

export interface ChapterEntry {
	chapterId: number;
	channelId: string;
	name: string;
}

export interface CoalitionEntry {
	/** Solidarity custom-property internal_name; also the /coalition-invite webhook key. */
	group: string;
	channelId: string;
	/** Custom property display label ('' when unknown). */
	name: string;
	/** Solidarity user list mirroring the property; null when not configured. */
	userListId: number | null;
}

export interface Settings {
	chapterChannelMap: ChapterEntry[];
	coalitionChannelMap: CoalitionEntry[];
	allowedSlackUserIds: Set<string>;
	reportExcludedChapterIds: Set<number>;
	/** Channels the bot should NOT post its channel welcome message in after
	 *  inviting a new member. Absent = welcome on (the default). DB-only. */
	welcomeDisabledChannelIds: Set<string>;
	slackTrackingChannelId: string;
	slackGrowthReportChannelId: string;
	slackGrowthReportRankingAlpha: number | undefined;
	/** Header countdown. DB-only, no env fallback; '' means "not configured". */
	countdownLabel: string;
	/** ISO datetime the countdown ends at; '' means "no countdown". */
	countdownEndAt: string;
	/** New-member welcome DM template. DB-only; '' means "use the built-in
	 *  default" (renderWelcomeDm falls back). Stored raw with `{{channels}}`
	 *  and `#channel-name` tokens resolved at send time. */
	welcomeDmMessage: string;
	/** Door-knock ticker scroll speed, in LED columns per second. DB-only;
	 *  always resolved to a usable number (see clampTickerColumnsPerSecond),
	 *  never undefined. */
	doorTickerColumnsPerSecond: number;
}

export interface Editor {
	/** Slack user id (`U…`) or the SYSTEM_EDITOR sentinel `U0000000000`. */
	id: string;
	/** Display name captured at write time. */
	name: string;
}

export type AppConfigPatch = Partial<{
	slackTrackingChannelId: string;
	slackGrowthReportChannelId: string;
	slackGrowthReportRankingAlpha: number;
	countdownLabel: string;
	countdownEndAt: string;
	welcomeDmMessage: string;
	doorTickerColumnsPerSecond: number;
}>;

/** Sentinel editor for non-interactive writes (seed/backfill). Stays in the
 *  same Slack id shape (`^U[A-Z0-9]{10}$`) so generic id validators accept it
 *  without a carve-out. */
export const SYSTEM_EDITOR: Editor = { id: 'U0000000000', name: 'System' } as const;

export async function loadSettings(db: Database): Promise<Settings> {
	// Five parallel reads. The coalition map is DB-only — an empty table simply
	// means "nothing mapped" (a delete must stay deleted). The chapter map,
	// allowed-users, and excluded-chapters lists shadow the env list entirely
	// when non-empty (FR-012). The app_config singleton row falls back
	// per-field (FR-013): a NULL column means "use env for that field", while
	// a missing row means "use env for all three".
	const [chapterRows, coalitionRows, allowedRows, excludedRows, welcomeRows, appConfigRows] =
		await Promise.all([
			db.select().from(chapterChannelMap),
			db.select().from(coalitionChannelMap),
			db.select().from(allowedSlackUsers),
			db.select().from(reportExcludedChapters),
			db.select().from(channelWelcomeFlags),
			db.select().from(appConfig).limit(1),
		]);

	const chapterChannelMapField: ChapterEntry[] =
		chapterRows.length > 0
			? chapterRows.map((r) => ({ chapterId: r.chapterId, channelId: r.channelId, name: r.name }))
			: SOLIDARITY_CHAPTER_CHANNEL_MAP;

	const coalitionChannelMapField: CoalitionEntry[] = coalitionRows.map((r) => ({
		group: r.groupName,
		channelId: r.channelId,
		name: r.name,
		userListId: r.userListId,
	}));

	const allowedSlackUserIds: Set<string> =
		allowedRows.length > 0
			? new Set(allowedRows.map((r) => r.slackUserId))
			: SLACK_ALLOWED_USER_IDS;

	const reportExcludedChapterIds: Set<number> =
		excludedRows.length > 0
			? new Set(excludedRows.map((r) => r.chapterId))
			: REPORT_EXCLUDED_CHAPTER_IDS;

	// DB-only, like the coalition map: no env fallback. Only rows with the
	// flag off matter — a row toggled back on behaves like no row.
	const welcomeDisabledChannelIds: Set<string> = new Set(
		welcomeRows.filter((r) => !r.showWelcomeMessage).map((r) => r.channelId),
	);

	const cfg = appConfigRows[0];
	const slackTrackingChannelId =
		cfg?.slackTrackingChannelId ?? SLACK_TRACKING_CHANNEL_ID;
	const slackGrowthReportChannelId =
		cfg?.slackGrowthReportChannelId ?? SLACK_GROWTH_REPORT_CHANNEL_ID;
	const slackGrowthReportRankingAlpha =
		cfg?.slackGrowthReportRankingAlpha ?? SLACK_GROWTH_REPORT_RANKING_ALPHA;
	const countdownLabel = cfg?.countdownLabel ?? '';
	const countdownEndAt = cfg?.countdownEndAt ?? '';
	const welcomeDmMessage = cfg?.welcomeDmMessage ?? '';
	// DB-only with a code default rather than an env fallback — it's a display
	// preference, not deployment config. Clamped on read so a hand-edited row
	// can't hand the board an unusable rate.
	const doorTickerColumnsPerSecond = clampTickerColumnsPerSecond(
		cfg?.doorTickerColumnsPerSecond,
	);

	return {
		chapterChannelMap: chapterChannelMapField,
		coalitionChannelMap: coalitionChannelMapField,
		allowedSlackUserIds,
		reportExcludedChapterIds,
		welcomeDisabledChannelIds,
		slackTrackingChannelId,
		slackGrowthReportChannelId,
		slackGrowthReportRankingAlpha,
		countdownLabel,
		countdownEndAt,
		welcomeDmMessage,
		doorTickerColumnsPerSecond,
	};
}

/** Set whether the bot posts its channel welcome message in `channelId` after
 *  inviting a new member. Upserts a flag row either way — keeping the row on
 *  re-enable preserves the audit trail of who last touched the flag. */
export async function setChannelWelcomeFlag(
	db: Database,
	channelId: string,
	showWelcomeMessage: boolean,
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		channelId,
		showWelcomeMessage,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(channelWelcomeFlags)
		.values(row)
		.onConflictDoUpdate({
			target: channelWelcomeFlags.channelId,
			set: {
				showWelcomeMessage: row.showWelcomeMessage,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(
		`[settings] saved channel_welcome_flags channel_id=${channelId} show=${showWelcomeMessage} by ${editor.id} (${editor.name})`,
	);
}

// Write path — multi-row tables. Each setter upserts in one round-trip via
// onConflictDoUpdate, stamps the three audit columns, and emits one [settings]
// log line (Constitution Principle V). Errors bubble — the calling HTTP endpoint
// (NAV-5+) owns failure logging because it has the request context.

/** Upsert one channel across many chapters in a single statement — the
 *  /settings multi-editor's "add a chip while N chapters are selected". */
export async function saveChapterChannelEntries(
	db: Database,
	chapters: { chapterId: number; name: string }[],
	channelId: string,
	editor: Editor,
): Promise<void> {
	if (chapters.length === 0) return;
	const lastEditedAt = new Date().toISOString();
	const rows = chapters.map((chapter) => ({
		chapterId: chapter.chapterId,
		channelId,
		name: chapter.name,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	}));
	await db
		.insert(chapterChannelMap)
		.values(rows)
		.onConflictDoUpdate({
			target: [chapterChannelMap.chapterId, chapterChannelMap.channelId],
			set: {
				// `excluded.*` so each conflicting row keeps its own name; the
				// audit columns are identical across the batch.
				name: sql`excluded.name`,
				lastEditedBy: editor.id,
				lastEditedByName: editor.name,
				lastEditedAt,
			},
		});
	console.log(
		`[settings] saved chapter_channel_map chapter_ids=[${chapters.map((c) => c.chapterId).join(', ')}] channel_id=${channelId} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteChapterChannelEntries(
	db: Database,
	chapterIds: number[],
	channelId: string,
	editor: Editor,
): Promise<void> {
	if (chapterIds.length === 0) return;
	await db
		.delete(chapterChannelMap)
		.where(
			and(
				inArray(chapterChannelMap.chapterId, chapterIds),
				eq(chapterChannelMap.channelId, channelId),
			),
		);
	console.log(
		`[settings] deleted chapter_channel_map chapter_ids=[${chapterIds.join(', ')}] channel_id=${channelId} by ${editor.id} (${editor.name})`,
	);
}

/**
 * One-time copy of the env fallback into chapter_channel_map. The table
 * shadows SOLIDARITY_CHAPTER_CHANNEL_MAP *entirely* once it has any row
 * (FR-012), so the first interactive edit must not start from an empty table —
 * that would silently drop every env mapping except the one being edited.
 * Callers invoke this before the first write; no-op when the table already has
 * rows or the env map is empty. Seed rows are attributed to SYSTEM_EDITOR.
 * The check-then-insert is not atomic, so the insert uses onConflictDoNothing:
 * two concurrent first edits may both pass the emptiness check, but the loser
 * then no-ops per row instead of tripping the composite PK.
 */
export async function ensureChapterChannelMapSeeded(db: Database): Promise<void> {
	const existing = await db
		.select({ chapterId: chapterChannelMap.chapterId })
		.from(chapterChannelMap)
		.limit(1);
	if (existing.length > 0 || SOLIDARITY_CHAPTER_CHANNEL_MAP.length === 0) return;

	const lastEditedAt = new Date().toISOString();
	await db
		.insert(chapterChannelMap)
		.values(
			SOLIDARITY_CHAPTER_CHANNEL_MAP.map((e) => ({
				chapterId: e.chapterId,
				channelId: e.channelId,
				name: e.name,
				lastEditedBy: SYSTEM_EDITOR.id,
				lastEditedByName: SYSTEM_EDITOR.name,
				lastEditedAt,
			})),
		)
		.onConflictDoNothing();
	console.log(
		`[settings] seeded chapter_channel_map with ${SOLIDARITY_CHAPTER_CHANNEL_MAP.length} env entries by ${SYSTEM_EDITOR.id} (${SYSTEM_EDITOR.name})`,
	);
}

export async function saveCoalitionEntry(
	db: Database,
	entry: { group: string; channelId: string; name: string; userListId: number | null },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		groupName: entry.group,
		channelId: entry.channelId,
		name: entry.name,
		userListId: entry.userListId,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(coalitionChannelMap)
		.values(row)
		.onConflictDoUpdate({
			target: coalitionChannelMap.groupName,
			set: {
				channelId: row.channelId,
				name: row.name,
				userListId: row.userListId,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(
		`[settings] saved coalition_channel_map group_name=${entry.group} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteCoalitionEntry(
	db: Database,
	group: string,
	editor: Editor,
): Promise<void> {
	await db.delete(coalitionChannelMap).where(eq(coalitionChannelMap.groupName, group));
	console.log(
		`[settings] deleted coalition_channel_map group_name=${group} by ${editor.id} (${editor.name})`,
	);
}

/**
 * One-time copy of the env fallback into allowed_slack_users — same rationale
 * and concurrency posture as ensureChapterChannelMapSeeded above: the table
 * shadows SLACK_ALLOWED_USER_IDS entirely once it has any row, so the first
 * interactive edit must inherit the env list instead of silently dropping
 * every admin except the one being edited. `displayNames` (from the cached
 * Slack user list, when available) makes seed rows human-readable; ids without
 * a known name fall back to the raw id.
 */
export async function ensureAllowedUsersSeeded(
	db: Database,
	displayNames?: ReadonlyMap<string, string>,
): Promise<void> {
	const existing = await db
		.select({ slackUserId: allowedSlackUsers.slackUserId })
		.from(allowedSlackUsers)
		.limit(1);
	if (existing.length > 0 || SLACK_ALLOWED_USER_IDS.size === 0) return;

	const lastEditedAt = new Date().toISOString();
	await db
		.insert(allowedSlackUsers)
		.values(
			[...SLACK_ALLOWED_USER_IDS].map((id) => ({
				slackUserId: id,
				displayName: displayNames?.get(id) ?? id,
				lastEditedBy: SYSTEM_EDITOR.id,
				lastEditedByName: SYSTEM_EDITOR.name,
				lastEditedAt,
			})),
		)
		.onConflictDoNothing();
	console.log(
		`[settings] seeded allowed_slack_users with ${SLACK_ALLOWED_USER_IDS.size} env entries by ${SYSTEM_EDITOR.id} (${SYSTEM_EDITOR.name})`,
	);
}

export async function saveAllowedUser(
	db: Database,
	entry: { slackUserId: string; displayName: string },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		slackUserId: entry.slackUserId,
		displayName: entry.displayName,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(allowedSlackUsers)
		.values(row)
		.onConflictDoUpdate({
			target: allowedSlackUsers.slackUserId,
			set: {
				displayName: row.displayName,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(
		`[settings] saved allowed_slack_users slack_user_id=${entry.slackUserId} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteAllowedUser(
	db: Database,
	slackUserId: string,
	editor: Editor,
): Promise<void> {
	await db.delete(allowedSlackUsers).where(eq(allowedSlackUsers.slackUserId, slackUserId));
	console.log(
		`[settings] deleted allowed_slack_users slack_user_id=${slackUserId} by ${editor.id} (${editor.name})`,
	);
}

/**
 * One-time copy of the env fallback into report_excluded_chapters — same
 * rationale and concurrency posture as the other ensure*Seeded helpers: the
 * table shadows REPORT_EXCLUDED_CHAPTER_IDS entirely once it has any row, so
 * the first interactive edit must inherit the env list. Env entries carry no
 * reason, so seed rows get reason NULL.
 */
export async function ensureExcludedChaptersSeeded(db: Database): Promise<void> {
	const existing = await db
		.select({ chapterId: reportExcludedChapters.chapterId })
		.from(reportExcludedChapters)
		.limit(1);
	if (existing.length > 0 || REPORT_EXCLUDED_CHAPTER_IDS.size === 0) return;

	const lastEditedAt = new Date().toISOString();
	await db
		.insert(reportExcludedChapters)
		.values(
			[...REPORT_EXCLUDED_CHAPTER_IDS].map((chapterId) => ({
				chapterId,
				reason: null,
				lastEditedBy: SYSTEM_EDITOR.id,
				lastEditedByName: SYSTEM_EDITOR.name,
				lastEditedAt,
			})),
		)
		.onConflictDoNothing();
	console.log(
		`[settings] seeded report_excluded_chapters with ${REPORT_EXCLUDED_CHAPTER_IDS.size} env entries by ${SYSTEM_EDITOR.id} (${SYSTEM_EDITOR.name})`,
	);
}

export async function saveExcludedChapter(
	db: Database,
	entry: { chapterId: number; reason?: string | null },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		chapterId: entry.chapterId,
		reason: entry.reason ?? null,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(reportExcludedChapters)
		.values(row)
		.onConflictDoUpdate({
			target: reportExcludedChapters.chapterId,
			set: {
				reason: row.reason,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(
		`[settings] saved report_excluded_chapters chapter_id=${entry.chapterId} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteExcludedChapter(
	db: Database,
	chapterId: number,
	editor: Editor,
): Promise<void> {
	await db
		.delete(reportExcludedChapters)
		.where(eq(reportExcludedChapters.chapterId, chapterId));
	console.log(
		`[settings] deleted report_excluded_chapters chapter_id=${chapterId} by ${editor.id} (${editor.name})`,
	);
}

// Write path — app-config singleton. Set-only contract: an undefined or null
// patch value is treated as ABSENT (kept), not as a NULL write. Unspecified
// fields are preserved across the upsert because they don't appear in the `set`
// clause (FR-019). Unknown patch keys throw synchronously — last-line defense
// for the HTTP endpoint that's expected to validate first.

const APP_CONFIG_ALLOWED_KEYS = new Set<keyof AppConfigPatch>([
	'slackTrackingChannelId',
	'slackGrowthReportChannelId',
	'slackGrowthReportRankingAlpha',
	'countdownLabel',
	'countdownEndAt',
	'welcomeDmMessage',
	'doorTickerColumnsPerSecond',
]);

export async function saveAppConfig(
	db: Database,
	patch: AppConfigPatch,
	editor: Editor,
): Promise<void> {
	for (const key of Object.keys(patch) as (keyof AppConfigPatch)[]) {
		if (!APP_CONFIG_ALLOWED_KEYS.has(key)) {
			throw new Error(`saveAppConfig: unknown patch key "${key}"`);
		}
	}

	// null and undefined both mean "leave as-is" — strip both before composing
	// the values payload and the on-conflict set clause.
	const definedFields: Record<string, string | number> = {};
	for (const key of APP_CONFIG_ALLOWED_KEYS) {
		const v = patch[key];
		if (v !== undefined && v !== null) {
			definedFields[key] = v;
		}
	}

	const lastEditedAt = new Date().toISOString();
	const values = {
		id: 1,
		...definedFields,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	const set: Record<string, string | number> = {
		...definedFields,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};

	await db
		.insert(appConfig)
		.values(values)
		.onConflictDoUpdate({ target: appConfig.id, set });

	const keysSummary = Object.keys(definedFields).join(',');
	console.log(
		`[settings] saved app_config patch=${keysSummary} by ${editor.id} (${editor.name})`,
	);
}

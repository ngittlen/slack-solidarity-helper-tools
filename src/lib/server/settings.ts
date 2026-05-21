// Settings storage seam for the upcoming admin settings page (NAV-3 through
// NAV-9). One typed `loadSettings(db)` that reads the five settings tables and
// falls back to env for any field whose row(s) are absent, plus per-table
// setters that stamp the audit columns and log the action. No HTTP surface in
// this slice — consumers are migrated per-route in NAV-5 through NAV-9.
//
// See specs/005-settings-storage-loader/contracts/settings-module.md for the
// full contract.

import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';

import {
	chapterChannelMap,
	coalitionChannelMap,
	allowedSlackUsers,
	reportExcludedChapters,
	appConfig,
} from './schema.js';
import {
	SOLIDARITY_CHAPTER_CHANNEL_MAP,
	COALITION_CHANNEL_MAP,
	SLACK_ALLOWED_USER_IDS,
	REPORT_EXCLUDED_CHAPTER_IDS,
	SLACK_TRACKING_CHANNEL_ID,
	SLACK_GROWTH_REPORT_CHANNEL_ID,
	SLACK_GROWTH_REPORT_RANKING_ALPHA,
} from './env.js';

export {
	chapterChannelMap,
	coalitionChannelMap,
	allowedSlackUsers,
	reportExcludedChapters,
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

export interface Settings {
	chapterChannelMap: ChapterEntry[];
	coalitionChannelMap: Record<string, string>;
	allowedSlackUserIds: Set<string>;
	reportExcludedChapterIds: Set<number>;
	slackTrackingChannelId: string;
	slackGrowthReportChannelId: string;
	slackGrowthReportRankingAlpha: number | undefined;
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
}>;

/** Sentinel editor for non-interactive writes (seed/backfill). Stays in the
 *  same Slack id shape (`^U[A-Z0-9]{10}$`) so generic id validators accept it
 *  without a carve-out. */
export const SYSTEM_EDITOR: Editor = { id: 'U0000000000', name: 'System' } as const;

export async function loadSettings(db: Database): Promise<Settings> {
	// Five parallel reads. Each multi-row table either shadows the env list entirely
	// (FR-012) or falls back to env when empty. The app_config singleton row falls
	// back per-field (FR-013): a NULL column means "use env for that field", while
	// a missing row means "use env for all three".
	const [chapterRows, coalitionRows, allowedRows, excludedRows, appConfigRows] = await Promise.all([
		db.select().from(chapterChannelMap),
		db.select().from(coalitionChannelMap),
		db.select().from(allowedSlackUsers),
		db.select().from(reportExcludedChapters),
		db.select().from(appConfig).limit(1),
	]);

	const chapterChannelMapField: ChapterEntry[] =
		chapterRows.length > 0
			? chapterRows.map((r) => ({ chapterId: r.chapterId, channelId: r.channelId, name: r.name }))
			: SOLIDARITY_CHAPTER_CHANNEL_MAP;

	const coalitionChannelMapField: Record<string, string> =
		coalitionRows.length > 0
			? Object.fromEntries(coalitionRows.map((r) => [r.groupName, r.channelId]))
			: COALITION_CHANNEL_MAP;

	const allowedSlackUserIds: Set<string> =
		allowedRows.length > 0
			? new Set(allowedRows.map((r) => r.slackUserId))
			: SLACK_ALLOWED_USER_IDS;

	const reportExcludedChapterIds: Set<number> =
		excludedRows.length > 0
			? new Set(excludedRows.map((r) => r.chapterId))
			: REPORT_EXCLUDED_CHAPTER_IDS;

	const cfg = appConfigRows[0];
	const slackTrackingChannelId =
		cfg?.slackTrackingChannelId ?? SLACK_TRACKING_CHANNEL_ID;
	const slackGrowthReportChannelId =
		cfg?.slackGrowthReportChannelId ?? SLACK_GROWTH_REPORT_CHANNEL_ID;
	const slackGrowthReportRankingAlpha =
		cfg?.slackGrowthReportRankingAlpha ?? SLACK_GROWTH_REPORT_RANKING_ALPHA;

	return {
		chapterChannelMap: chapterChannelMapField,
		coalitionChannelMap: coalitionChannelMapField,
		allowedSlackUserIds,
		reportExcludedChapterIds,
		slackTrackingChannelId,
		slackGrowthReportChannelId,
		slackGrowthReportRankingAlpha,
	};
}

// Write path — multi-row tables. Each setter upserts in one round-trip via
// onConflictDoUpdate, stamps the three audit columns, and emits one [settings]
// log line (Constitution Principle V). Errors bubble — the calling HTTP endpoint
// (NAV-5+) owns failure logging because it has the request context.

export async function saveChapterChannelEntry(
	db: Database,
	entry: { chapterId: number; channelId: string; name: string },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		chapterId: entry.chapterId,
		channelId: entry.channelId,
		name: entry.name,
		lastEditedBy: editor.id,
		lastEditedByName: editor.name,
		lastEditedAt,
	};
	await db
		.insert(chapterChannelMap)
		.values(row)
		.onConflictDoUpdate({
			target: chapterChannelMap.chapterId,
			set: {
				channelId: row.channelId,
				name: row.name,
				lastEditedBy: row.lastEditedBy,
				lastEditedByName: row.lastEditedByName,
				lastEditedAt: row.lastEditedAt,
			},
		});
	console.log(
		`[settings] saved chapter_channel_map chapter_id=${entry.chapterId} by ${editor.id} (${editor.name})`,
	);
}

export async function deleteChapterChannelEntry(
	db: Database,
	chapterId: number,
	editor: Editor,
): Promise<void> {
	await db.delete(chapterChannelMap).where(eq(chapterChannelMap.chapterId, chapterId));
	console.log(
		`[settings] deleted chapter_channel_map chapter_id=${chapterId} by ${editor.id} (${editor.name})`,
	);
}

export async function saveCoalitionEntry(
	db: Database,
	entry: { group: string; channelId: string },
	editor: Editor,
): Promise<void> {
	const lastEditedAt = new Date().toISOString();
	const row = {
		groupName: entry.group,
		channelId: entry.channelId,
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

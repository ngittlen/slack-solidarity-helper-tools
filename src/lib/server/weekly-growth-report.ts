// Weekly per-chapter Slack-signup growth report. Reads slack_joins, splits each
// chapter's members into "existing" (joined before the window) and "new" (joined
// within the window), ranks by growth percentage, and posts the top 5 to a
// Slack channel with extra fanfare for #1.
//
// Same import-discipline as solidarity-snapshot.ts: no $env/$lib imports so this
// module stays trivially importable from a standalone script if we add one later.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { KnownBlock, WebClient } from '@slack/web-api';
import { sql, eq, desc } from 'drizzle-orm';
import { loadChapterNames } from './chapter-names.js';
import { weeklyGrowthWindows, weeklyChapterGrowth } from './schema.js';

const TOP_N = 5;
const WINDOW_DAYS = 7;
// Power-law exponent for the ranking score: score = newJoins / (existing + 1)^α
//   α = 1   → pure relative growth (small chapters dominate)
//   α = 0.7 → small chapters still tend to win, large ones become competitive
//   α = 0.5 → square-root denominator, large chapters favored
//   α = 0   → pure absolute count
// The +1 in the denominator avoids dividing by zero for brand-new chapters.
// The endpoint can override this via the SLACK_GROWTH_REPORT_RANKING_ALPHA env var.
const DEFAULT_RANKING_ALPHA = 0.5;

export interface ChapterGrowth {
	chapterId: number;
	chapterName: string;
	/** Slack channel ID for this chapter, when SOLIDARITY_CHAPTER_CHANNEL_MAP has
	 * an entry — used to render a clickable channel mention in the Slack post. */
	slackChannelId: string | null;
	newJoins: number;
	existing: number;
	/** Raw growth percentage shown in the post: newJoins / existing * 100.
	 * Ranking uses a separate power-law score (see rankingAlpha) — sort order
	 * does not match pct order. 0 when existing is 0 (chapter is brand new). */
	pct: number;
}

export interface WeeklyGrowthResult {
	windowStart: string;
	windowEnd: string;
	chaptersWithGrowth: number;
	totalNewJoins: number;
	topChapters: ChapterGrowth[];
	posted: boolean;
}

// Pin the window to UTC midnight at the start of the most recent Monday. This
// keeps the dashboard leaderboard stable Mon-to-Mon (matching what the cron
// posts) instead of sliding by a day every UTC midnight. The cron itself fires
// Monday 14:00 UTC, where "most recent Monday" is just-past midnight — so the
// cron's reported window is unchanged.
export function computeWindow(now: Date): { start: Date; end: Date } {
	const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
	const daysBackToMonday = day === 0 ? 6 : day - 1;
	const todayMidnightMs = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate()
	);
	const endMs = todayMidnightMs - daysBackToMonday * 24 * 60 * 60 * 1000;
	const end = new Date(endMs);
	const start = new Date(endMs - WINDOW_DAYS * 24 * 60 * 60 * 1000);
	return { start, end };
}

function roundPct(p: number): number {
	return Math.round(p * 10) / 10;
}

// Power-law ranking score shared between the cron's compute path and the
// dashboard's saved/live leaderboard reads, so all three sort orders agree.
function rankingScore(c: ChapterGrowth, alpha: number): number {
	return c.newJoins / Math.pow(c.existing + 1, alpha);
}

function sortByRanking(rows: ChapterGrowth[], alpha: number): void {
	rows.sort((a, b) => {
		const sa = rankingScore(a, alpha);
		const sb = rankingScore(b, alpha);
		if (sb !== sa) return sb - sa;
		return b.newJoins - a.newJoins;
	});
}

function fmtDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

// Render a chapter as a clickable Slack channel mention when we have its
// channel ID; otherwise bold the chapter name as plain text. `<#C…>` is auto-
// rendered by Slack with the current channel name and stays correct on rename.
function chapterMention(c: ChapterGrowth): string {
	return c.slackChannelId ? `<#${c.slackChannelId}>` : `*${c.chapterName}*`;
}

function buildBlocks(top: ChapterGrowth[], windowStart: Date, windowEnd: Date): KnownBlock[] {
	const winner = top[0]!;
	const winnerSummary = winner.existing > 0
		? `Grew their Slack chapter by *${roundPct(winner.pct)}%* with *${winner.newJoins} new* member${winner.newJoins === 1 ? '' : 's'} this week.`
		: `Welcomed *${winner.newJoins}* new Slack member${winner.newJoins === 1 ? '' : 's'} — and they're brand new on Slack!`;

	const blocks: KnownBlock[] = [
		{ type: 'header', text: { type: 'plain_text', text: '📈 Weekly Growth Report', emoji: true } },
		{
			type: 'context',
			elements: [
				{ type: 'mrkdwn', text: `Slack signups, ${fmtDate(windowStart)} → ${fmtDate(windowEnd)}` },
			],
		},
		{ type: 'divider' },
		{
			type: 'header',
			text: { type: 'plain_text', text: '🏆  Chapter of the Week  🏆', emoji: true },
		},
		{
			type: 'section',
			text: {
				type: 'mrkdwn',
				text: `${chapterMention(winner)}\n\n${winnerSummary}\n\nA huge shoutout to the ${chapterMention(winner)} organisers — keep up the incredible momentum! :raised_hands: :rocket:`,
			},
		},
	];

	if (top.length > 1) {
		const lines = top.slice(1).map((r, i) => {
			const place = i + 2;
			const detail = r.existing > 0
				? `+${r.newJoins} (${roundPct(r.pct)}% growth)`
				: `+${r.newJoins} (brand new on Slack)`;
			return `*${place}.* ${chapterMention(r)} — ${detail}`;
		});
		blocks.push({
			type: 'section',
			text: { type: 'mrkdwn', text: `*Runners up*\n${lines.join('\n')}` },
		});
	}

	return blocks;
}

export interface WeeklyLeaderboard {
	windowStart: string;
	windowEnd: string;
	/** All chapters with newJoins > 0 in the window (post-exclusion), pre-slice. */
	chaptersWithGrowth: number;
	/** Distinct users who joined Slack in the window (excluded chapters still count). */
	totalNewJoins: number;
	/** Top TOP_N entries by ranking score, descending. */
	topChapters: ChapterGrowth[];
}

/** A leaderboard load that either succeeded or failed with a user-facing message. */
export type LeaderboardResult =
	| { ok: true; leaderboard: WeeklyLeaderboard }
	| { ok: false; error: string };

/** The two leaderboard views the dashboard renders behind a tab toggle:
 * `saved` is the last cron snapshot, `live` is the in-progress week. */
export interface LeaderboardPair {
	saved: LeaderboardResult;
	live: LeaderboardResult;
}

/**
 * Reads the most recent snapshot written by the Monday cron and reconstructs
 * the leaderboard from it. Returns an empty leaderboard if no snapshot exists
 * yet (e.g., cron has never run). Deliberately does NOT recompute from live
 * data: the whole point of the snapshot is to preserve the chapter-size
 * (`existing`) figures captured at window-end, so the dashboard doesn't drift
 * as live num_members grows.
 *
 * `rankingAlpha` and `chapterChannelIds` are accepted so the caller can re-sort
 * with a different α than the cron used, and refresh the channel mention map
 * if SOLIDARITY_CHAPTER_CHANNEL_MAP changed since the snapshot was written.
 */
export async function computeWeeklyLeaderboard(
	db: LibSQLDatabase<Record<string, unknown>>,
	options: {
		excludedChapterIds?: ReadonlySet<number>;
		chapterChannelIds?: ReadonlyMap<number, string>;
		rankingAlpha?: number;
	} = {},
): Promise<WeeklyLeaderboard> {
	const excluded = options.excludedChapterIds ?? new Set<number>();
	const chapterChannelIds = options.chapterChannelIds;
	const rankingAlpha = options.rankingAlpha ?? DEFAULT_RANKING_ALPHA;

	const latestWindow = await db
		.select()
		.from(weeklyGrowthWindows)
		.orderBy(desc(weeklyGrowthWindows.windowEnd))
		.limit(1);

	if (latestWindow.length === 0) {
		const now = new Date();
		const { start, end } = computeWindow(now);
		return {
			windowStart: start.toISOString(),
			windowEnd: end.toISOString(),
			chaptersWithGrowth: 0,
			totalNewJoins: 0,
			topChapters: [],
		};
	}

	const win = latestWindow[0]!;
	const rows = await db
		.select()
		.from(weeklyChapterGrowth)
		.where(eq(weeklyChapterGrowth.windowEnd, win.windowEnd));

	const leaderboard: ChapterGrowth[] = rows
		.filter((r) => !excluded.has(r.chapterId))
		.map((r) => ({
			chapterId: r.chapterId,
			chapterName: r.chapterName,
			// Prefer the live channel map if provided (handles renames / new
			// mappings since the snapshot was written), otherwise fall back to
			// the channel id captured at compute time.
			slackChannelId: chapterChannelIds?.get(r.chapterId) ?? r.slackChannelId,
			newJoins: r.newJoins,
			existing: r.existing,
			pct: r.existing > 0 ? (r.newJoins / r.existing) * 100 : 0,
		}));

	sortByRanking(leaderboard, rankingAlpha);

	return {
		windowStart: win.windowStart,
		windowEnd: win.windowEnd,
		chaptersWithGrowth: leaderboard.length,
		totalNewJoins: win.totalNewJoins,
		topChapters: leaderboard.slice(0, TOP_N),
	};
}

/**
 * Live leaderboard for the in-progress week — the data the next cron run
 * will eventually snapshot. The window runs from the latest snapshot's
 * `windowEnd` (or, if no snapshot exists yet, the most recent UTC Monday
 * midnight via `computeWindow`) up to `now`.
 *
 * Computes per-chapter counts directly from `slack_joins` (no Slack API
 * calls) so this stays fast on dashboard loads. When a snapshot exists,
 * the `existing` baseline reuses each chapter's `numMembers` from the
 * snapshot row (Slack's ground-truth count captured at `windowEnd`);
 * otherwise it falls back to a `slack_joins`-derived count of members who
 * joined before the window started.
 */
export async function computeLiveLeaderboardSinceSnapshot(
	db: LibSQLDatabase<Record<string, unknown>>,
	options: {
		now?: Date;
		excludedChapterIds?: ReadonlySet<number>;
		chapterChannelIds?: ReadonlyMap<number, string>;
		rankingAlpha?: number;
	} = {},
): Promise<WeeklyLeaderboard> {
	const excluded = options.excludedChapterIds ?? new Set<number>();
	const chapterChannelIds = options.chapterChannelIds;
	const rankingAlpha = options.rankingAlpha ?? DEFAULT_RANKING_ALPHA;
	const now = options.now ?? new Date();

	const latestWindow = await db
		.select()
		.from(weeklyGrowthWindows)
		.orderBy(desc(weeklyGrowthWindows.windowEnd))
		.limit(1);

	// Anchor the window at the most recent snapshot's `windowEnd` when one
	// exists, otherwise fall back to the most recent UTC Monday midnight so
	// the live tab still shows something useful (and meaningfully distinct
	// from the saved tab's empty-state Mon-to-Mon range) before the first
	// cron has run.
	const win = latestWindow[0];
	const windowStartIso = win ? win.windowEnd : computeWindow(now).end.toISOString();
	const windowEndIso = now.toISOString();

	const snapshotRows = win
		? await db
				.select()
				.from(weeklyChapterGrowth)
				.where(eq(weeklyChapterGrowth.windowEnd, win.windowEnd))
		: [];

	const snapshotByChapter = new Map<
		number,
		{ chapterName: string; slackChannelId: string | null; numMembers: number | null }
	>();
	for (const r of snapshotRows) {
		snapshotByChapter.set(r.chapterId, {
			chapterName: r.chapterName,
			slackChannelId: r.slackChannelId,
			numMembers: r.numMembers,
		});
	}

	// Same json_each aggregation the cron uses (runWeeklyGrowthReport), but
	// for the new [snapshotEnd, now) window. `existing` here is the slack_joins-
	// derived count of pre-window members and is used as a fallback when the
	// snapshot didn't capture a numMembers for this chapter.
	const aggRows = (await db.all(sql`
		SELECT
			CAST(je.value AS INTEGER) AS chapter_id,
			SUM(CASE WHEN joined_at >= ${windowStartIso} AND joined_at < ${windowEndIso} THEN 1 ELSE 0 END) AS new_joins,
			SUM(CASE WHEN joined_at IS NULL OR joined_at < ${windowStartIso}              THEN 1 ELSE 0 END) AS existing
		FROM slack_joins, json_each(slack_joins.chapter_ids) je
		GROUP BY chapter_id
	`)) as Array<{ chapter_id: number; new_joins: number; existing: number }>;

	const names = await loadChapterNames(db);

	const leaderboard: ChapterGrowth[] = aggRows
		.map((row) => ({
			chapterId: Number(row.chapter_id),
			newJoins: Number(row.new_joins),
			sqlExisting: Number(row.existing),
		}))
		.filter((c) => c.newJoins > 0 && !excluded.has(c.chapterId))
		.map((c) => {
			const snap = snapshotByChapter.get(c.chapterId);
			const existing = snap?.numMembers ?? c.sqlExisting;
			const chapterName = snap?.chapterName ?? names.get(c.chapterId) ?? `Chapter #${c.chapterId}`;
			const slackChannelId = chapterChannelIds?.get(c.chapterId) ?? snap?.slackChannelId ?? null;
			const pct = existing > 0 ? (c.newJoins / existing) * 100 : 0;
			return {
				chapterId: c.chapterId,
				chapterName,
				slackChannelId,
				newJoins: c.newJoins,
				existing,
				pct,
			};
		});

	sortByRanking(leaderboard, rankingAlpha);

	const totalNewJoinsRow = (await db.all(sql`
		SELECT COUNT(*) AS cnt FROM slack_joins
		WHERE joined_at >= ${windowStartIso} AND joined_at < ${windowEndIso}
	`)) as Array<{ cnt: number }>;
	const totalNewJoins = Number(totalNewJoinsRow[0]?.cnt ?? 0);

	return {
		windowStart: windowStartIso,
		windowEnd: windowEndIso,
		chaptersWithGrowth: leaderboard.length,
		totalNewJoins,
		topChapters: leaderboard.slice(0, TOP_N),
	};
}

/**
 * Write the per-chapter leaderboard to the snapshot tables. Idempotent: a
 * re-run for the same window (manual cron retry, dry-run flip) replaces the
 * previous rows.
 */
async function persistSnapshot(
	db: LibSQLDatabase<Record<string, unknown>>,
	windowStartIso: string,
	windowEndIso: string,
	totalNewJoins: number,
	rows: Array<ChapterGrowth & { numMembers: number | null }>,
): Promise<void> {
	const computedAt = new Date().toISOString();

	await db
		.insert(weeklyGrowthWindows)
		.values({
			windowEnd: windowEndIso,
			windowStart: windowStartIso,
			totalNewJoins,
			computedAt,
		})
		.onConflictDoUpdate({
			target: weeklyGrowthWindows.windowEnd,
			set: { windowStart: windowStartIso, totalNewJoins, computedAt },
		});

	// Wipe any prior rows for this window before re-inserting — keeps the table
	// clean if a chapter dropped out of the leaderboard on a re-run.
	await db.delete(weeklyChapterGrowth).where(eq(weeklyChapterGrowth.windowEnd, windowEndIso));

	for (const row of rows) {
		await db.insert(weeklyChapterGrowth).values({
			windowEnd: windowEndIso,
			chapterId: row.chapterId,
			chapterName: row.chapterName,
			slackChannelId: row.slackChannelId,
			newJoins: row.newJoins,
			existing: row.existing,
			numMembers: row.numMembers,
		});
	}
}

export async function runWeeklyGrowthReport(
	db: LibSQLDatabase<Record<string, unknown>>,
	slack: WebClient,
	channelId: string,
	options: {
		now?: Date;
		dryRun?: boolean;
		excludedChapterIds?: ReadonlySet<number>;
		/** chapterId → Slack channel ID. When mapped, that channel's num_members
		 * is used as ground truth for chapter size; otherwise we fall back to
		 * the slack_joins-derived count. */
		chapterChannelIds?: ReadonlyMap<number, string>;
		/** Power-law exponent for the ranking score. Defaults to
		 * DEFAULT_RANKING_ALPHA. */
		rankingAlpha?: number;
	} = {},
): Promise<WeeklyGrowthResult> {
	const excluded = options.excludedChapterIds ?? new Set<number>();
	const chapterChannelIds = options.chapterChannelIds ?? new Map<number, string>();
	const rankingAlpha = options.rankingAlpha ?? DEFAULT_RANKING_ALPHA;
	const now = options.now ?? new Date();
	const { start: windowStart, end: windowEnd } = computeWindow(now);
	const windowStartIso = windowStart.toISOString();
	const windowEndIso = windowEnd.toISOString();

	// Aggregate per-chapter counts in SQL via json_each so we never round-trip
	// every slack_joins row across the wire. Rows with chapter_ids = '[]' produce
	// no json_each rows and are naturally excluded. NULL joined_at counts as
	// "existing" — those are backfilled rows from before the live join handler
	// existed, where Slack's API doesn't expose the original join date.
	const aggRows = (await db.all(sql`
		SELECT
			CAST(je.value AS INTEGER) AS chapter_id,
			SUM(CASE WHEN joined_at >= ${windowStartIso} AND joined_at < ${windowEndIso} THEN 1 ELSE 0 END) AS new_joins,
			SUM(CASE WHEN joined_at IS NULL OR joined_at < ${windowStartIso}              THEN 1 ELSE 0 END) AS existing
		FROM slack_joins, json_each(slack_joins.chapter_ids) je
		GROUP BY chapter_id
	`)) as Array<{ chapter_id: number; new_joins: number; existing: number }>;

	const names = await loadChapterNames(db);

	// Build candidate list, then fetch ground-truth chapter size from Slack
	// (channel num_members) where a channel mapping is configured. Slack reports
	// the *current* channel size, which already includes this week's new joins,
	// so subtract newJoins to recover the start-of-window size.
	const candidates = aggRows
		.map((row) => ({
			chapterId: Number(row.chapter_id),
			newJoins: Number(row.new_joins),
			sqlExisting: Number(row.existing),
		}))
		.filter((c) => c.newJoins > 0 && !excluded.has(c.chapterId));

	const enriched = await Promise.all(
		candidates.map(async (c) => {
			const slackChannelId = chapterChannelIds.get(c.chapterId) ?? null;
			if (!slackChannelId) {
				console.warn(
					`[growth] no channel mapping for chapter ${c.chapterId} — using slack_joins count (${c.sqlExisting})`,
				);
				return {
					...c,
					existing: c.sqlExisting,
					numMembers: null as number | null,
					slackChannelId,
					slackChannelName: null as string | null,
				};
			}
			try {
				const info = await slack.conversations.info({
					channel: slackChannelId,
					include_num_members: true,
				});
				const num = info.channel?.num_members;
				const slackChannelName = info.channel?.name ?? null;
				if (typeof num === 'number') {
					return {
						...c,
						existing: Math.max(0, num - c.newJoins),
						numMembers: num,
						slackChannelId,
						slackChannelName,
					};
				}
				console.warn(
					`[growth] conversations.info returned no num_members for chapter ${c.chapterId} (channel ${slackChannelId})`,
				);
				return {
					...c,
					existing: c.sqlExisting,
					numMembers: null as number | null,
					slackChannelId,
					slackChannelName,
				};
			} catch (err) {
				console.warn(
					`[growth] conversations.info failed for chapter ${c.chapterId} (channel ${slackChannelId}):`,
					err instanceof Error ? err.message : err,
				);
				return {
					...c,
					existing: c.sqlExisting,
					numMembers: null as number | null,
					slackChannelId,
					slackChannelName: null as string | null,
				};
			}
		}),
	);

	const leaderboard: Array<ChapterGrowth & { numMembers: number | null }> = enriched.map((c) => {
		const chapterName = c.slackChannelName
			? `#${c.slackChannelName}`
			: names.get(c.chapterId) ?? `Chapter #${c.chapterId}`;
		const pct = c.existing > 0 ? (c.newJoins / c.existing) * 100 : 0;
		return {
			chapterId: c.chapterId,
			chapterName,
			slackChannelId: c.slackChannelId,
			newJoins: c.newJoins,
			existing: c.existing,
			numMembers: c.numMembers,
			pct,
		};
	});
	sortByRanking(leaderboard, rankingAlpha);

	const topChapters = leaderboard.slice(0, TOP_N);
	// Distinct count of users who joined the workspace this window. Counted
	// against the slack_joins rows directly (each row is one user) so multi-
	// chapter users don't get double-counted, and excluded chapters don't drop
	// anyone — this answers "how many joined Slack this week?" overall.
	const totalNewJoinsRow = (await db.all(sql`
		SELECT COUNT(*) AS cnt FROM slack_joins
		WHERE joined_at >= ${windowStartIso} AND joined_at < ${windowEndIso}
	`)) as Array<{ cnt: number }>;
	const totalNewJoins = Number(totalNewJoinsRow[0]?.cnt ?? 0);

	if (!options.dryRun) {
		await persistSnapshot(db, windowStartIso, windowEndIso, totalNewJoins, leaderboard);
	}

	let posted = false;
	if (topChapters.length > 0 && !options.dryRun) {
		const blocks = buildBlocks(topChapters, windowStart, windowEnd);
		await slack.chat.postMessage({
			channel: channelId,
			text: `Weekly growth report — chapter of the week: ${topChapters[0]!.chapterName}`,
			blocks,
		});
		posted = true;
	}

	return {
		windowStart: windowStartIso,
		windowEnd: windowEndIso,
		chaptersWithGrowth: leaderboard.length,
		totalNewJoins,
		topChapters,
		posted,
	};
}

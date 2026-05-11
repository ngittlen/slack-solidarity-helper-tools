// Weekly per-chapter Slack-signup growth report. Reads slack_joins, splits each
// chapter's members into "existing" (joined before the window) and "new" (joined
// within the window), ranks by growth percentage, and posts the top 5 to a
// Slack channel with extra fanfare for #1.
//
// Same import-discipline as solidarity-snapshot.ts: no $env/$lib imports so this
// module stays trivially importable from a standalone script if we add one later.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { KnownBlock, WebClient } from '@slack/web-api';
import { sql } from 'drizzle-orm';
import { loadChapterNames } from './chapter-names.js';

const TOP_N = 5;
const WINDOW_DAYS = 7;
// Power-law exponent for the ranking score: score = newJoins / (existing + 1)^α
//   α = 1   → pure relative growth (small chapters dominate)
//   α = 0.7 → small chapters still tend to win, large ones become competitive
//   α = 0.5 → square-root denominator, large chapters favored
//   α = 0   → pure absolute count
// The +1 in the denominator avoids dividing by zero for brand-new chapters.
// The endpoint can override this via the SLACK_GROWTH_REPORT_RANKING_ALPHA env var.
const DEFAULT_RANKING_ALPHA = 0.7;

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

// Pin the window to UTC midnight boundaries so the report covers the same range
// regardless of when GitHub Actions actually fires the cron (it can be delayed
// by minutes-to-hours under load). End = UTC midnight at the start of the run
// date; start = end - 7 days. Running Monday morning means reporting on the
// 7-day block ending at the previous midnight.
function computeWindow(now: Date): { start: Date; end: Date } {
	const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const end = new Date(endMs);
	const start = new Date(endMs - WINDOW_DAYS * 24 * 60 * 60 * 1000);
	return { start, end };
}

function roundPct(p: number): number {
	return Math.round(p * 10) / 10;
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
				text: `:tada: :sparkles: :tada:\n\n${chapterMention(winner)}\n\n${winnerSummary}\n\nA huge shoutout to the ${chapterMention(winner)} organisers — keep up the incredible momentum! :raised_hands: :rocket:`,
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
		blocks.push({ type: 'divider' });
		blocks.push({
			type: 'section',
			text: { type: 'mrkdwn', text: `*Runners up*\n${lines.join('\n')}` },
		});
	}

	return blocks;
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
				return { ...c, existing: c.sqlExisting, slackChannelId, slackChannelName: null as string | null };
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
						slackChannelId,
						slackChannelName,
					};
				}
				console.warn(
					`[growth] conversations.info returned no num_members for chapter ${c.chapterId} (channel ${slackChannelId})`,
				);
				return { ...c, existing: c.sqlExisting, slackChannelId, slackChannelName };
			} catch (err) {
				console.warn(
					`[growth] conversations.info failed for chapter ${c.chapterId} (channel ${slackChannelId}):`,
					err instanceof Error ? err.message : err,
				);
				return { ...c, existing: c.sqlExisting, slackChannelId, slackChannelName: null as string | null };
			}
		}),
	);

	const leaderboard: ChapterGrowth[] = enriched.map((c) => {
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
			pct,
		};
	});
	const rankingScore = (c: ChapterGrowth) =>
		c.newJoins / Math.pow(c.existing + 1, rankingAlpha);
	leaderboard.sort((a, b) => {
		const sa = rankingScore(a);
		const sb = rankingScore(b);
		if (sb !== sa) return sb - sa;
		return b.newJoins - a.newJoins;
	});

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

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
import { solidarityDailySnapshots } from './schema.js';

const TOP_N = 5;
const WINDOW_DAYS = 7;

export interface ChapterGrowth {
	chapterId: number;
	chapterName: string;
	newJoins: number;
	existing: number;
	/** Percent growth. Infinity for chapters with existing == 0. */
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

function buildBlocks(top: ChapterGrowth[], windowStart: Date, windowEnd: Date): KnownBlock[] {
	const winner = top[0]!;
	const winnerSummary = Number.isFinite(winner.pct)
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
				text: `:tada: :sparkles: :tada:\n\n*${winner.chapterName}*\n\n${winnerSummary}\n\nA huge shoutout to the *${winner.chapterName}* organisers — keep up the incredible momentum! :raised_hands: :rocket:`,
			},
		},
	];

	if (top.length > 1) {
		const lines = top.slice(1).map((r, i) => {
			const place = i + 2;
			const detail = Number.isFinite(r.pct)
				? `+${r.newJoins} (${roundPct(r.pct)}% growth)`
				: `+${r.newJoins} (brand new on Slack)`;
			return `*${place}.* *${r.chapterName}* — ${detail}`;
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
	options: { now?: Date; dryRun?: boolean; excludedChapterIds?: ReadonlySet<number> } = {},
): Promise<WeeklyGrowthResult> {
	const excluded = options.excludedChapterIds ?? new Set<number>();
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

	// Borrow chapter names from the denormalised snapshot table (written nightly
	// by the Solidarity snapshot job). Anything missing falls back to "Chapter #N".
	const nameRows = await db
		.select({
			chapterId: solidarityDailySnapshots.chapterId,
			chapterName: solidarityDailySnapshots.chapterName,
		})
		.from(solidarityDailySnapshots);
	const names = new Map<number, string>();
	for (const r of nameRows) {
		if (r.chapterName && !names.has(r.chapterId)) names.set(r.chapterId, r.chapterName);
	}

	const leaderboard: ChapterGrowth[] = [];
	for (const row of aggRows) {
		const newJoins = Number(row.new_joins);
		const existing = Number(row.existing);
		if (newJoins === 0) continue;
		const chapterId = Number(row.chapter_id);
		if (excluded.has(chapterId)) continue;
		const chapterName = names.get(chapterId) ?? `Chapter #${chapterId}`;
		const pct = existing > 0 ? (newJoins / existing) * 100 : Number.POSITIVE_INFINITY;
		leaderboard.push({ chapterId, chapterName, newJoins, existing, pct });
	}
	leaderboard.sort((a, b) => {
		if (b.pct !== a.pct) return b.pct - a.pct;
		return b.newJoins - a.newJoins;
	});

	const topChapters = leaderboard.slice(0, TOP_N);
	const totalNewJoins = leaderboard.reduce((sum, c) => sum + c.newJoins, 0);

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

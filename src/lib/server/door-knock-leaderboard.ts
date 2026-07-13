// Doors-knocked leaderboard for the dashboard, mirroring the Slack growth
// leaderboard: same Monday-pinned week windows (campaign-local, see
// currentWeekMonday) and the same
// power-law ranking math, with "doors knocked the previous week" as the
// denominator — score = doors / (prevWeekDoors + 1)^α — so the board
// highlights chapters improving the most week-over-week. While no prior-week
// data exists (denominator 1 for everyone) this is exactly a raw-total
// ranking, and it transitions to improvement-weighted automatically once a
// previous week is on record.
//
// Both tabs read door_knock_daily only (data through last night's snapshot) —
// unlike the Slack board, history is already frozen per day, so no separate
// snapshot table is needed.
//
// Same import discipline as weekly-growth-report.ts: no $env/$lib imports.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';
import { reRank, DEFAULT_RANKING_ALPHA, TOP_N } from '../growth-ranking.js';

export interface DoorsChapterEntry {
	chapterName: string;
	/** Doors knocked in the window. */
	doors: number;
	contacts: number;
	/** Doors knocked in the PREVIOUS window — the ranking denominator. */
	prevDoors: number;
	/** Week-over-week change: (doors - prevDoors) / prevDoors * 100. 0 when
	 *  prevDoors is 0 (first week knocking). */
	pct: number;
}

export interface DoorsLeaderboard {
	windowStart: string;
	windowEnd: string;
	/** Doors knocked across ALL chapters in the window, not just the top 5. */
	totalDoors: number;
	/** Contacts across ALL chapters in the window. */
	totalContacts: number;
	/** totalContacts / totalDoors * 100; 0 when no doors. */
	contactRatePct: number;
	/** Top TOP_N entries by ranking score, descending. */
	topChapters: DoorsChapterEntry[];
}

export type DoorsLeaderboardResult =
	| { ok: true; leaderboard: DoorsLeaderboard }
	| { ok: false; error: string };

export interface DoorsLeaderboardPair {
	lastWeek: DoorsLeaderboardResult;
	thisWeek: DoorsLeaderboardResult;
}

interface WindowTotals {
	doors: number;
	contacts: number;
}

function fmtDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
	return new Date(d.getTime() + days * 86_400_000);
}

// Start of the current week (Monday) pinned to the campaign's clock
// (America/Detroit), NOT UTC. The Slack board's computeWindow uses UTC day
// boundaries, so every Sunday between 8 pm ET (Monday 00:00 UTC) and midnight
// ET it already reports the *next* Monday — which pushed this board a full week
// ahead into an empty "this week so far" window while the Slack board (anchored
// to the last saved Monday snapshot) still showed the real current week.
// Pinning to Detroit keeps the two boards in step. Returns UTC midnight of the
// Detroit Monday's calendar date so fmtDate() yields the intended day string.
function currentWeekMonday(now: Date): Date {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/Detroit',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		weekday: 'short',
	}).formatToParts(now);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	const daysBackToMonday: Record<string, number> = {
		Mon: 0,
		Tue: 1,
		Wed: 2,
		Thu: 3,
		Fri: 4,
		Sat: 5,
		Sun: 6,
	};
	const back = daysBackToMonday[get('weekday')] ?? 0;
	const midnight = Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')));
	return new Date(midnight - back * 86_400_000);
}

function buildLeaderboard(
	byChapter: Map<string, WindowTotals>,
	prevByChapter: Map<string, WindowTotals>,
	windowStart: Date,
	windowEnd: Date,
	rankingAlpha: number,
): DoorsLeaderboard {
	const entries = [...byChapter.entries()]
		.filter(([, t]) => t.doors > 0)
		.map(([chapterName, t]) => {
			const prevDoors = prevByChapter.get(chapterName)?.doors ?? 0;
			return {
				chapterName,
				doors: t.doors,
				contacts: t.contacts,
				prevDoors,
				pct: prevDoors > 0 ? ((t.doors - prevDoors) / prevDoors) * 100 : 0,
				// RankableChapter adapter: same score as the Slack board with the
				// previous week's doors as the size denominator.
				newJoins: t.doors,
				existing: prevDoors,
			};
		});

	const top = reRank(entries, rankingAlpha, TOP_N).map(
		({ chapterName, doors, contacts, prevDoors, pct }) => ({
			chapterName,
			doors,
			contacts,
			prevDoors,
			pct,
		}),
	);

	const totalDoors = [...byChapter.values()].reduce((sum, t) => sum + t.doors, 0);
	const totalContacts = [...byChapter.values()].reduce((sum, t) => sum + t.contacts, 0);
	return {
		windowStart: windowStart.toISOString(),
		windowEnd: windowEnd.toISOString(),
		totalDoors,
		totalContacts,
		contactRatePct: totalDoors > 0 ? (totalContacts / totalDoors) * 100 : 0,
		topChapters: top,
	};
}

/** Both leaderboard tabs from door_knock_daily. `thisWeek` covers the current
 *  Monday-started week through last night's snapshot; `lastWeek` is the last
 *  completed week (ranked against the week before it). */
export async function computeDoorsLeaderboardPair(
	db: LibSQLDatabase<Record<string, unknown>>,
	options: { rankingAlpha?: number; now?: Date } = {},
): Promise<DoorsLeaderboardPair> {
	const rankingAlpha = options.rankingAlpha ?? DEFAULT_RANKING_ALPHA;
	const now = options.now ?? new Date();

	// Pin the current week to the campaign's Monday (America/Detroit); its start
	// is last week's end. The ranking denominators need one more week back.
	const thisWeekStart = currentWeekMonday(now);
	const lastWeekEnd = thisWeekStart;
	const lastWeekStart = addDays(thisWeekStart, -7);
	const thisWeekEnd = addDays(thisWeekStart, 7);
	const weekBeforeStart = addDays(lastWeekStart, -7);

	// Rows are keyed by ET date string; window date strings bucket them.
	// [weekBeforeStart, thisWeekEnd) spans all three windows in one read.
	const rows = (await db.all(sql`
		SELECT date, chapter_name, SUM(attempts) AS doors, SUM(contacts) AS contacts
		FROM door_knock_daily
		WHERE date >= ${fmtDate(weekBeforeStart)} AND date < ${fmtDate(thisWeekEnd)}
		GROUP BY date, chapter_name
	`)) as Array<{ date: string; chapter_name: string; doors: number; contacts: number }>;

	const weekBefore = new Map<string, WindowTotals>();
	const lastWeek = new Map<string, WindowTotals>();
	const thisWeek = new Map<string, WindowTotals>();
	const lastWeekStartStr = fmtDate(lastWeekStart);
	const lastWeekEndStr = fmtDate(lastWeekEnd);

	for (const row of rows) {
		const bucket =
			row.date < lastWeekStartStr ? weekBefore : row.date < lastWeekEndStr ? lastWeek : thisWeek;
		const totals = bucket.get(row.chapter_name) ?? { doors: 0, contacts: 0 };
		totals.doors += Number(row.doors);
		totals.contacts += Number(row.contacts);
		bucket.set(row.chapter_name, totals);
	}

	return {
		lastWeek: {
			ok: true,
			leaderboard: buildLeaderboard(lastWeek, weekBefore, lastWeekStart, lastWeekEnd, rankingAlpha),
		},
		thisWeek: {
			ok: true,
			leaderboard: buildLeaderboard(thisWeek, lastWeek, lastWeekEnd, thisWeekEnd, rankingAlpha),
		},
	};
}

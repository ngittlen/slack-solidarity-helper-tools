// Read-side aggregation for the dashboard's signups-per-day chart.
// Returns Solidarity (from solidarity_daily_snapshots) and Slack (from
// slack_joins) counts bucketed by date, each with a per-chapter breakdown.
//
// Same import discipline as solidarity-snapshot.ts and weekly-growth-report.ts:
// no $env/$lib imports so this module stays trivially importable from tests
// and standalone scripts.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { and, asc, gte, notInArray, sql, type SQL } from 'drizzle-orm';
import { solidarityDailySnapshots } from './schema.js';
import { loadChapterNames } from './chapter-names.js';
import { DISTINCT_TOTAL_SENTINEL } from './solidarity-snapshot.js';

const NULL_CHAPTER_SENTINEL = -1;

export interface ChapterCount {
	chapterId: number | null;
	chapterName: string | null;
	count: number;
}

export interface DaySignups {
	date: string;
	total: number;
	byChapter: ChapterCount[];
}

export interface DashboardSignups {
	solidarity: DaySignups[];
	slack: DaySignups[];
}

export interface GetDashboardSignupsOptions {
	days: number;
	now?: Date;
	/** Chapter IDs to omit from the result (e.g. test / internal-only chapters).
	 *  Solidarity: drops rows entirely. Slack: drops per-chapter rows and also
	 *  drops users whose chapter_ids contain ONLY excluded chapters (so totals
	 *  stay consistent with the visible bands). */
	excludedChapterIds?: ReadonlySet<number>;
}

// Window covers the last `days` calendar dates (UTC), inclusive of today.
// e.g. days=1 → just today; days=90 → today and the 89 prior days.
function windowStartDate(days: number, now: Date): string {
	const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const start = new Date(todayUtc - (days - 1) * 24 * 60 * 60 * 1000);
	return start.toISOString().slice(0, 10);
}

// Sort byChapter ascending by chapterId, with the null bucket last.
function sortByChapter(a: ChapterCount, b: ChapterCount): number {
	if (a.chapterId === null) return 1;
	if (b.chapterId === null) return -1;
	return a.chapterId - b.chapterId;
}

export async function loadSolidaritySignups(
	db: LibSQLDatabase<Record<string, unknown>>,
	options: GetDashboardSignupsOptions,
): Promise<DaySignups[]> {
	return loadSolidarity(
		db,
		windowStartDate(options.days, options.now ?? new Date()),
		options.excludedChapterIds ?? new Set(),
	);
}

export async function loadSlackSignups(
	db: LibSQLDatabase<Record<string, unknown>>,
	options: GetDashboardSignupsOptions,
): Promise<DaySignups[]> {
	return loadSlack(
		db,
		windowStartDate(options.days, options.now ?? new Date()),
		options.excludedChapterIds ?? new Set(),
	);
}

async function loadSolidarity(
	db: LibSQLDatabase<Record<string, unknown>>,
	startDate: string,
	excluded: ReadonlySet<number>,
): Promise<DaySignups[]> {
	// User-supplied excluded IDs only contain real chapter IDs, so the SQL
	// filter naturally leaves the DISTINCT_TOTAL_SENTINEL row through. We
	// separate it from real-chapter rows in JS below.
	const conditions: SQL[] = [gte(solidarityDailySnapshots.date, startDate)];
	if (excluded.size > 0) {
		conditions.push(notInArray(solidarityDailySnapshots.chapterId, [...excluded]));
	}
	const rows = await db
		.select({
			date: solidarityDailySnapshots.date,
			chapterId: solidarityDailySnapshots.chapterId,
			chapterName: solidarityDailySnapshots.chapterName,
			count: solidarityDailySnapshots.count,
		})
		.from(solidarityDailySnapshots)
		.where(and(...conditions))
		.orderBy(asc(solidarityDailySnapshots.date), asc(solidarityDailySnapshots.chapterId));

	const byDate = new Map<string, DaySignups>();
	const distinctTotalByDate = new Map<string, number>();
	for (const row of rows) {
		if (row.chapterId === DISTINCT_TOTAL_SENTINEL) {
			distinctTotalByDate.set(row.date, row.count);
			continue;
		}
		let day = byDate.get(row.date);
		if (!day) {
			day = { date: row.date, total: 0, byChapter: [] };
			byDate.set(row.date, day);
		}
		const isNull = row.chapterId === NULL_CHAPTER_SENTINEL;
		day.byChapter.push({
			chapterId: isNull ? null : row.chapterId,
			chapterName: isNull ? null : row.chapterName,
			count: row.count,
		});
		// Running sum-of-bands; overridden below with the distinct count when
		// available and no chapter-level exclusion is in effect.
		day.total += row.count;
	}
	// Prefer the snapshot's distinct-user count over sum-of-bands so multi-
	// chapter members aren't double-counted. With chapter exclusion active we
	// keep sum-of-bands because the sentinel still counts users in excluded
	// chapters — sum-of-(non-excluded)-bands is the right total for that case.
	// Legacy days written before the sentinel existed have no entry here and
	// keep the sum-of-bands fallback.
	if (excluded.size === 0) {
		for (const [date, distinctTotal] of distinctTotalByDate) {
			const day = byDate.get(date);
			if (day) day.total = distinctTotal;
		}
	}
	const days = [...byDate.values()];
	for (const d of days) d.byChapter.sort(sortByChapter);
	days.sort((a, b) => a.date.localeCompare(b.date));
	return days;
}

async function loadSlack(
	db: LibSQLDatabase<Record<string, unknown>>,
	startDate: string,
	excluded: ReadonlySet<number>,
): Promise<DaySignups[]> {
	// Excluded chapter IDs come from a trusted env var, so inlining as a comma
	// list is safe (drizzle's `sql.raw` skips bind parameters). When empty, the
	// fragments below collapse to `sql``.
	const excludedList =
		excluded.size > 0 ? sql.raw([...excluded].join(',')) : null;
	const chapterExclusion = excludedList
		? sql`AND CAST(je.value AS INTEGER) NOT IN (${excludedList})`
		: sql``;
	const totalExclusion = excludedList
		? sql`AND (
			chapter_ids = '[]'
			OR EXISTS (
				SELECT 1 FROM json_each(slack_joins.chapter_ids) je2
				WHERE CAST(je2.value AS INTEGER) NOT IN (${excludedList})
			)
		)`
		: sql``;

	// Per-chapter buckets via json_each. Rows with chapter_ids = '[]' produce
	// no json_each rows and are picked up separately below.
	const chapterRows = (await db.all(sql`
		SELECT DATE(joined_at) AS date,
		       CAST(je.value AS INTEGER) AS chapter_id,
		       COUNT(*) AS count
		FROM slack_joins, json_each(slack_joins.chapter_ids) je
		WHERE joined_at IS NOT NULL AND DATE(joined_at) >= ${startDate}
		${chapterExclusion}
		GROUP BY date, chapter_id
	`)) as Array<{ date: string; chapter_id: number; count: number }>;

	// No-chapter bucket — rows with chapter_ids = '[]'. Exclusion doesn't apply
	// here since these rows have no chapter IDs to match against.
	const nullChapterRows = (await db.all(sql`
		SELECT DATE(joined_at) AS date, COUNT(*) AS count
		FROM slack_joins
		WHERE joined_at IS NOT NULL
		  AND chapter_ids = '[]'
		  AND DATE(joined_at) >= ${startDate}
		GROUP BY date
	`)) as Array<{ date: string; count: number }>;

	// Distinct daily totals — each slack_joins row is one user, so multi-chapter
	// users aren't double-counted. Users whose chapter_ids contain ONLY excluded
	// chapters drop out so the total stays consistent with the visible bands.
	const totalRows = (await db.all(sql`
		SELECT DATE(joined_at) AS date, COUNT(*) AS total
		FROM slack_joins
		WHERE joined_at IS NOT NULL AND DATE(joined_at) >= ${startDate}
		${totalExclusion}
		GROUP BY date
	`)) as Array<{ date: string; total: number }>;

	const names = await loadChapterNames(db);
	const byDate = new Map<string, DaySignups>();
	const day = (date: string) => {
		let d = byDate.get(date);
		if (!d) {
			d = { date, total: 0, byChapter: [] };
			byDate.set(date, d);
		}
		return d;
	};

	for (const r of chapterRows) {
		day(r.date).byChapter.push({
			chapterId: Number(r.chapter_id),
			chapterName: names.get(Number(r.chapter_id)) ?? `Chapter #${r.chapter_id}`,
			count: Number(r.count),
		});
	}
	for (const r of nullChapterRows) {
		day(r.date).byChapter.push({
			chapterId: null,
			chapterName: null,
			count: Number(r.count),
		});
	}
	for (const r of totalRows) {
		day(r.date).total = Number(r.total);
	}

	const days = [...byDate.values()];
	for (const d of days) d.byChapter.sort(sortByChapter);
	days.sort((a, b) => a.date.localeCompare(b.date));
	return days;
}

export async function getDashboardSignups(
	db: LibSQLDatabase<Record<string, unknown>>,
	options: GetDashboardSignupsOptions,
): Promise<DashboardSignups> {
	const startDate = windowStartDate(options.days, options.now ?? new Date());
	const excluded = options.excludedChapterIds ?? new Set<number>();
	const [solidarity, slack] = await Promise.all([
		loadSolidarity(db, startDate, excluded),
		loadSlack(db, startDate, excluded),
	]);
	return { solidarity, slack };
}

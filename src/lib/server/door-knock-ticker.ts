// Daily personal door-knock leaderboard — the names that scroll across the
// dashboard's LED ticker.
//
// Reads door_knock_canvasser_daily, which the snapshot fills from the same
// provider rows that feed door_knock_daily. A person can canvass
// under several conversation codes in a day (a metro code in the morning, a
// county code in the afternoon), so the day's total per person is the sum
// across codes — hence the aggregation here rather than a plain SELECT.
//
// The day shown is the latest date the table has rows for, matching how the
// charts anchor their windows: on a live canvassing day that IS today (the
// 30-minute refresh keeps it current), and overnight it holds the day that
// just finished rather than blanking out.
//
// Same import discipline as the other read-side modules: no $env/$lib imports.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { desc, eq, max, sum } from 'drizzle-orm';
import { doorKnockCanvasserDaily } from './schema.js';

type Database = LibSQLDatabase<Record<string, unknown>>;

/** How many names the ticker carries. Enough to feel alive without the loop
 *  getting so long that nobody sees their own name come round. */
export const TICKER_TOP_N = 10;

export interface TickerEntry {
	canvasser: string;
	doors: number;
	/** The chapter this person knocked the most doors in today. Someone who
	 *  worked two chapters is shown under the busier one rather than listed
	 *  twice — a ticker cell has room for one region. '' when unknown. */
	chapter: string;
	/** 1-based standing for the day, ties broken by name. */
	rank: number;
}

export interface DoorKnockTicker {
	/** The day these standings cover, or null when there's no data at all. */
	date: string | null;
	entries: TickerEntry[];
}

const EMPTY: DoorKnockTicker = { date: null, entries: [] };

export async function loadDoorKnockTicker(
	db: Database,
	options: { limit?: number } = {},
): Promise<DoorKnockTicker> {
	const limit = options.limit ?? TICKER_TOP_N;

	const latest = await db
		.select({ max: max(doorKnockCanvasserDaily.date) })
		.from(doorKnockCanvasserDaily);
	const date = latest[0]?.max ?? null;
	if (date === null) return EMPTY;

	// Grouped by (person, chapter) rather than by person alone: the day's total
	// is the sum across those groups, and the busiest group names their region.
	// Aggregating per person in SQL would have thrown the chapter away.
	// A day's worth of rows is small — one per canvasser per chapter — so the
	// ranking and the top-N cut happen below rather than in the query.
	const doors = sum(doorKnockCanvasserDaily.attempts);
	const rows = await db
		.select({
			canvasser: doorKnockCanvasserDaily.canvasser,
			chapter: doorKnockCanvasserDaily.chapterName,
			doors,
		})
		.from(doorKnockCanvasserDaily)
		.where(eq(doorKnockCanvasserDaily.date, date))
		.groupBy(doorKnockCanvasserDaily.canvasser, doorKnockCanvasserDaily.chapterName)
		.orderBy(desc(doors), doorKnockCanvasserDaily.canvasser);

	const byCanvasser = new Map<string, { doors: number; chapter: string; chapterDoors: number }>();
	for (const row of rows) {
		// SUM() arrives as a string.
		const rowDoors = Number(row.doors);
		const entry = byCanvasser.get(row.canvasser);
		if (!entry) {
			byCanvasser.set(row.canvasser, {
				doors: rowDoors,
				chapter: row.chapter,
				chapterDoors: rowDoors,
			});
			continue;
		}
		entry.doors += rowDoors;
		// Ties broken alphabetically so the region shown doesn't flip between
		// refreshes for someone split evenly across two chapters.
		if (
			rowDoors > entry.chapterDoors ||
			(rowDoors === entry.chapterDoors && row.chapter.localeCompare(entry.chapter) < 0)
		) {
			entry.chapter = row.chapter;
			entry.chapterDoors = rowDoors;
		}
	}

	const entries = [...byCanvasser.entries()]
		.map(([canvasser, e]) => ({ canvasser, doors: e.doors, chapter: e.chapter }))
		// Someone whose rows are all zeros has nothing to celebrate yet and
		// would just pad the ticker with 0s.
		.filter((e) => e.doors > 0)
		// Biggest first; the secondary sort on name keeps the order stable
		// between refreshes when two people are tied — a ticker that reshuffles
		// equal scores on every poll looks broken.
		.sort((a, b) => b.doors - a.doors || a.canvasser.localeCompare(b.canvasser))
		.slice(0, limit)
		.map((e, i) => ({ ...e, rank: i + 1 }));

	return entries.length === 0 ? EMPTY : { date, entries };
}

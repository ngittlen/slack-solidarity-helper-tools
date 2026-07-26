// Daily personal door-knock leaderboard — the names that scroll across the
// dashboard's LED ticker.
//
// Reads door_knock_canvasser_daily, which the snapshot fills from the same
// Openfield leaderboards that feed door_knock_daily. A person can canvass
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
	/** 1-based standing for the day, ties broken by name (see the ORDER BY). */
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

	// Sum across codes, biggest first. The secondary sort on name keeps the
	// order stable between refreshes when two people are tied — a ticker that
	// reshuffles equal scores on every poll looks broken.
	const doors = sum(doorKnockCanvasserDaily.attempts);
	const rows = await db
		.select({ canvasser: doorKnockCanvasserDaily.canvasser, doors })
		.from(doorKnockCanvasserDaily)
		.where(eq(doorKnockCanvasserDaily.date, date))
		.groupBy(doorKnockCanvasserDaily.canvasser)
		.orderBy(desc(doors), doorKnockCanvasserDaily.canvasser)
		.limit(limit);

	const entries = rows
		// SUM() arrives as a string; a person whose only rows are zeros has
		// nothing to celebrate yet and would just pad the ticker with 0s.
		.map((r) => ({ canvasser: r.canvasser, doors: Number(r.doors) }))
		.filter((r) => r.doors > 0)
		.map((r, i) => ({ ...r, rank: i + 1 }));

	return entries.length === 0 ? EMPTY : { date, entries };
}

// Projects the total doors knocked by the countdown deadline: doors recorded
// so far plus the recent daily pace extrapolated over the time remaining.
//
// Pace = mean of the last PROJECTION_WINDOW_DAYS snapshot dates (or as many
// as exist). Dates come from door_knock_daily, which records a row per code
// even on zero-door days, so quiet days correctly drag the pace down —
// but days the snapshot didn't run at all are simply absent and don't.
//
// Same import discipline as the other read-side modules: no $env/$lib
// imports, db injected.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';

export const PROJECTION_WINDOW_DAYS = 7;

export interface DoorKnockDayTotal {
	date: string;
	total: number;
}

/** All-time per-date door totals, ascending by date. */
export async function loadDoorKnockDayTotals(
	db: LibSQLDatabase<Record<string, unknown>>,
): Promise<DoorKnockDayTotal[]> {
	const rows = (await db.all(sql`
		SELECT date, SUM(attempts) AS total
		FROM door_knock_daily
		GROUP BY date
		ORDER BY date
	`)) as Array<{ date: string; total: number }>;
	return rows.map((r) => ({ date: r.date, total: Number(r.total) }));
}

/** Doors knocked so far plus the recent pace times the (fractional) days
 *  until `endAtMs`. Null when there's no data to extrapolate from or the
 *  deadline is invalid/already passed. */
export function projectDoorsAtDeadline(
	dayTotals: DoorKnockDayTotal[],
	endAtMs: number,
	nowMs: number,
): number | null {
	if (dayTotals.length === 0) return null;
	const remainingDays = (endAtMs - nowMs) / 86_400_000;
	if (!Number.isFinite(remainingDays) || remainingDays <= 0) return null;

	const totalToDate = dayTotals.reduce((sum, d) => sum + d.total, 0);
	const window = dayTotals.slice(-PROJECTION_WINDOW_DAYS);
	const dailyPace = window.reduce((sum, d) => sum + d.total, 0) / window.length;

	return Math.round(totalToDate + dailyPace * remainingDays);
}

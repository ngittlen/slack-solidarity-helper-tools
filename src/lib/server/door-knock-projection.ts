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
 *  until `endAtMs`. The pace is per CANVASSING day (the snapshot rows are
 *  whole-day totals), so the remaining time counts only door-knocking hours
 *  (8 am – 9 pm America/Detroit) rather than assuming 24/7 knocking. Null
 *  when there's no data to extrapolate from or the deadline is
 *  invalid/already passed. */
export function projectDoorsAtDeadline(
	dayTotals: DoorKnockDayTotal[],
	endAtMs: number,
	nowMs: number,
): number | null {
	if (dayTotals.length === 0) return null;
	if (!Number.isFinite(endAtMs) || endAtMs <= nowMs) return null;

	const totalToDate = dayTotals.reduce((sum, d) => sum + d.total, 0);
	const window = dayTotals.slice(-PROJECTION_WINDOW_DAYS);
	const dailyPace = window.reduce((sum, d) => sum + d.total, 0) / window.length;

	const remainingCanvassDays = knockableMsBetween(nowMs, endAtMs) / KNOCK_DAY_MS;
	return Math.round(totalToDate + dailyPace * remainingCanvassDays);
}

// Door-knocking hours: 8 am – 9 pm campaign-local (America/Detroit).
export const KNOCK_START_HOUR = 8;
export const KNOCK_END_HOUR = 21;
export const KNOCK_DAY_MS = (KNOCK_END_HOUR - KNOCK_START_HOUR) * 3_600_000;

const DAY_MS = 86_400_000;

function detroitMsOfDay(ms: number): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/Detroit',
		hour12: false,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(new Date(ms));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
	// hour12:false can render midnight as "24" in some ICU versions.
	return (get('hour') % 24) * 3_600_000 + get('minute') * 60_000 + get('second') * 1_000;
}

/** Milliseconds of door-knocking time (8 am – 9 pm America/Detroit) between
 *  two instants. Walks local days assuming a fixed 24 h length — the two DST
 *  transition days a year are off by ≤1 h, immaterial for a "~" estimate. */
export function knockableMsBetween(startMs: number, endMs: number): number {
	const windowStart = KNOCK_START_HOUR * 3_600_000;
	const windowEnd = KNOCK_END_HOUR * 3_600_000;
	let total = 0;
	let cursor = startMs;
	// Iteration cap well beyond any realistic countdown horizon.
	for (let i = 0; cursor < endMs && i < 3_000; i++) {
		const msOfDay = detroitMsOfDay(cursor);
		if (msOfDay < windowEnd) {
			const knockStart = cursor + Math.max(0, windowStart - msOfDay);
			const knockEnd = cursor + (windowEnd - msOfDay);
			total += Math.max(0, Math.min(knockEnd, endMs) - knockStart);
		}
		cursor += DAY_MS - msOfDay; // next local midnight
	}
	return total;
}

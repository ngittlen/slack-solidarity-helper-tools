// The Mobilize sync's read of every Solidarity event, handed to the attendee
// sync. The scheduler runs the two back to back on one machine, and both read
// every event: tens of paged requests each, against Solidarity's 60 per 30
// seconds. The attendee sync takes the session times, caps and titles from a
// read made minutes before rather than making its own.
//
// Taken once, and only while fresh: the attendee sync run at another time, or
// on the other machine, finds nothing and reads for itself.

import type { SolidarityEvent } from '../../../mobilize-migrator/lib/solidarity.js';

/** How old a read may be when taken: one Mobilize sync's chunks, at most a
 *  few minutes, and the attendee sync starts as they end. */
export const HANDOFF_MAX_AGE_MS = 10 * 60_000;

let handed: { at: number; events: SolidarityEvent[]; drop: ReturnType<typeof setTimeout> } | null =
	null;

/** Hand on `events`, read at `at`. A later read replaces an earlier one. */
export function handSolidarityEvents(events: SolidarityEvent[], at = Date.now()): void {
	if (handed) clearTimeout(handed.drop);
	// Not kept past its use: every event, with its sessions, is not small.
	const drop = setTimeout(() => {
		handed = null;
	}, HANDOFF_MAX_AGE_MS);
	drop.unref?.();
	handed = { at, events, drop };
}

/** A read handed on, and when it was made. */
export interface HandedEvents {
	at: number;
	events: SolidarityEvent[];
}

/** The read handed on, once; null when none was, or it is stale. */
export function takeSolidarityEvents(now = Date.now()): HandedEvents | null {
	const taken = handed;
	if (!taken) return null;
	clearTimeout(taken.drop);
	handed = null;
	return fresh(taken, now) ? { at: taken.at, events: taken.events } : null;
}

/** Whether a read is still young enough to stand in for one made `now`. A
 *  taker that holds it a while asks again before using it. */
export function fresh(read: { at: number }, now = Date.now()): boolean {
	return now - read.at <= HANDOFF_MAX_AGE_MS;
}

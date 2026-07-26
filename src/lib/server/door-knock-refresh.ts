// On-demand door-knock refresh: as election day approaches the nightly
// snapshot is too slow a cadence, so a dashboard visit re-runs the Openfield
// snapshot when nobody has run one in the last DOOR_KNOCK_REFRESH_MS.
//
// Re-running mid-day is safe by construction: runDoorKnockSnapshot upserts
// (date, code) rows from Openfield's today-only leaderboard, so a fresh run
// just overwrites today's row with newer numbers (see door-knock-snapshot.ts).
//
// Two layers keep visits from stampeding Openfield (one login + one GET per
// conversation code per run):
//
//  1. A DB claim on the door_knock_refresh singleton — a conditional UPDATE
//     that only wins when the last ATTEMPT started outside the window. It's
//     stamped at claim time, not on success, so a failing run throttles the
//     next attempt exactly like a successful one instead of letting every
//     page view start a new attempt against a broken Openfield.
//  2. An in-process single-flight promise, so several visitors landing at once
//     on the same instance share one run and all get told when it's done.
//
// No $env/$lib imports — the snapshot runner is injected (the HTTP endpoint
// wires it from env), same discipline as door-knock-snapshot.ts.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq, lte } from 'drizzle-orm';
import { doorKnockRefresh } from './schema.js';
import { errMessage } from '../err-message.js';

type Database = LibSQLDatabase<Record<string, unknown>>;

/** How long a door-knock snapshot counts as fresh. */
export const DOOR_KNOCK_REFRESH_MS = 30 * 60 * 1000;

export interface DoorKnockRefreshStatus {
	/** ISO timestamp the last attempt was claimed; null when none ever ran. */
	startedAt: string | null;
	/** ISO timestamp the last attempt settled; null while one is in flight. */
	finishedAt: string | null;
}

export type RefreshStatus =
	/** This call ran (or awaited) a snapshot that has now finished. */
	| 'refreshed'
	/** Another attempt already covers the window; nothing was run. */
	| 'skipped'
	/** An attempt ran and threw; the window is still consumed. */
	| 'failed';

export interface RefreshOutcome {
	status: RefreshStatus;
	error?: string;
}

export async function readDoorKnockRefreshStatus(db: Database): Promise<DoorKnockRefreshStatus> {
	const rows = await db
		.select({ startedAt: doorKnockRefresh.startedAt, finishedAt: doorKnockRefresh.finishedAt })
		.from(doorKnockRefresh);
	const row = rows[0];
	return { startedAt: row?.startedAt ?? null, finishedAt: row?.finishedAt ?? null };
}

/** True when a visit should ask the server to refresh: either the last attempt
 *  is older than the window, or one is in flight right now (in which case the
 *  visitor waits on it rather than starting a second). */
export function needsDoorKnockRefresh(
	status: DoorKnockRefreshStatus,
	nowMs: number,
	intervalMs: number = DOOR_KNOCK_REFRESH_MS,
): boolean {
	if (status.startedAt === null) return true;
	const startedMs = Date.parse(status.startedAt);
	// An unparseable timestamp shouldn't wedge refreshes off forever.
	if (!Number.isFinite(startedMs)) return true;
	if (nowMs - startedMs >= intervalMs) return true;
	return status.finishedAt === null;
}

/** Conditional claim of the refresh slot. Returns true only for the caller
 *  that wins it; everyone else must not run a snapshot. */
export async function claimDoorKnockRefresh(
	db: Database,
	now: Date,
	intervalMs: number = DOOR_KNOCK_REFRESH_MS,
): Promise<boolean> {
	const nowIso = now.toISOString();
	const cutoffIso = new Date(now.getTime() - intervalMs).toISOString();
	// ISO-8601 UTC strings compare lexicographically in the same order as the
	// instants they name, so a string comparison is a valid staleness test.
	// `<=` matches needsDoorKnockRefresh's `>=`, so a page that decides it's
	// due at exactly the window boundary isn't turned away by the claim.
	//
	// `setWhere` is what makes this a CLAIM rather than a plain upsert: the
	// DO UPDATE is skipped when someone else's attempt is still fresh, and
	// rowsAffected then reports 0 — one atomic statement, no read-then-write
	// race between concurrent visitors.
	const result = await db
		.insert(doorKnockRefresh)
		.values({ id: 1, startedAt: nowIso, finishedAt: null, ok: null, error: null })
		.onConflictDoUpdate({
			target: doorKnockRefresh.id,
			set: { startedAt: nowIso, finishedAt: null, ok: null, error: null },
			setWhere: lte(doorKnockRefresh.startedAt, cutoffIso),
		});
	return result.rowsAffected > 0;
}

/** Unconditionally stamp the start of an attempt — for the scheduled snapshot,
 *  which always runs and must reset the window rather than ask for it. Never
 *  throws; the scheduled snapshot must not be blocked by its own bookkeeping. */
export async function beginDoorKnockRefresh(db: Database, now: Date): Promise<void> {
	const nowIso = now.toISOString();
	try {
		await db
			.insert(doorKnockRefresh)
			.values({ id: 1, startedAt: nowIso, finishedAt: null, ok: null, error: null })
			.onConflictDoUpdate({
				target: doorKnockRefresh.id,
				set: { startedAt: nowIso, finishedAt: null, ok: null, error: null },
			});
	} catch (err) {
		console.error('[door-knock] recording refresh start failed:', errMessage(err));
	}
}

/** Record how the in-flight attempt settled. `error` null means success.
 *  Never throws: this is bookkeeping, and callers are in the middle of
 *  reporting the snapshot's own result. If the write is lost, the claim's
 *  started_at still throttles the next attempt. */
export async function endDoorKnockRefresh(
	db: Database,
	now: Date,
	error: string | null,
): Promise<void> {
	try {
		await db
			.update(doorKnockRefresh)
			.set({ finishedAt: now.toISOString(), ok: error === null, error })
			.where(eq(doorKnockRefresh.id, 1));
	} catch (err) {
		console.error('[door-knock] recording refresh completion failed:', errMessage(err));
	}
}

// Shared by every concurrent caller on this instance while a run is in flight.
let inFlight: Promise<RefreshOutcome> | null = null;

/** Run the door-knock snapshot unless one has run within the window. Callers
 *  that arrive mid-run await the in-flight one instead of starting a second,
 *  so they can refresh their chart as soon as the numbers land. */
export async function refreshDoorKnockIfStale(
	db: Database,
	runSnapshot: () => Promise<unknown>,
	options: { now?: () => Date; intervalMs?: number } = {},
): Promise<RefreshOutcome> {
	if (inFlight) return inFlight;

	const now = options.now ?? (() => new Date());
	const intervalMs = options.intervalMs ?? DOOR_KNOCK_REFRESH_MS;

	// The claim lives INSIDE the shared promise: it awaits a DB round trip, and
	// a caller arriving during that await must join this attempt rather than
	// race it to a claim it would lose.
	const run = (async (): Promise<RefreshOutcome> => {
		if (!(await claimDoorKnockRefresh(db, now(), intervalMs))) {
			return { status: 'skipped' };
		}
		try {
			await runSnapshot();
			await endDoorKnockRefresh(db, now(), null);
			return { status: 'refreshed' };
		} catch (err) {
			const message = errMessage(err);
			console.error('[door-knock] on-demand refresh failed:', message);
			await endDoorKnockRefresh(db, now(), message);
			return { status: 'failed', error: message };
		}
	})();

	inFlight = run;
	try {
		return await run;
	} finally {
		inFlight = null;
	}
}

/** Test seam — drops the shared in-flight promise between cases. */
export function _resetDoorKnockRefreshState(): void {
	inFlight = null;
}

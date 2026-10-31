// The organizers' "Sync VAN now" button.
//
// An organizer who cuts new turf to answer a request should not have to wait
// out the half hour until the next scheduled sync before the volunteer can see
// it. This runs the scheduler's own VAN pass (runVanSync) between slots, so the
// endpoint stays the one place that decides what a sync does.
//
// The pass can take several minutes, longer than anyone should wait on a form
// submit, so it is started and left running; the page says so and the
// "last synced" line shows when it lands. A promise left running here
// finishes unless the machine stops — a deploy, or Fly stopping a second
// machine once traffic drops. Then the locks expire and nothing is lost; see
// below for the press that was waiting on it.
//
// A press while a scheduled sync is running waits for it, then runs. Started
// straight away, the endpoint would wait 75s for each campaign's lock, give up
// and skip the catalog — and the scheduled run may have read VAN before the
// organizer's new turf existed, leaving it for the next slot. Waiting first
// means the turf always lands without anyone having to press again.
//
// Then, still under its lock, whatever `afterPass` the caller gives it — the
// page's is the map-shape drain (manual-geometry.ts), so the turf the organizer
// cut lands on the map, not just in the list. Run even when the pass reports a
// campaign failing: the others' new turf still wants its shapes.
//
// A press while one is already running is folded into it rather than refused.
// An organizer who cuts more turf ten minutes into a half-hour drain needs VAN
// read again; the running press reads it at its next chance. The press leaves
// a request (MANUAL_VAN_RESYNC); the drain stops at its next slice when it sees
// one, and the running press does another pass, then drains again — new turf
// first, since the queue takes turf not on the map first. Every pass clears the
// request as it starts, so any number of presses meanwhile cost one pass.
// After MAX_PASSES the press hands the request still standing to a fresh run
// (see the end of runHolding), so drains are bounded per run but no press goes
// unanswered. The fresh run keeps the lock and the press's record, so the
// page goes on following one press, and counts what it picked up from when
// it was first pressed.
//
// A press that finds the lock held by a press that has since died — the
// machine restarted mid-run — would leave a request nobody answers until the
// lock's TTL and someone presses again. So it watches: a live holder's lock
// expiry moves with every heartbeat; one that stops moving is dead, and the
// waiting press takes the lock once it expires and runs.
//
// Its own lock, not the scheduler's: `schedule:<job>` is held until just
// before the next slot, so it is nearly always taken. Short and kept alive
// while the pass runs, so a crash frees it in minutes while no pass, however
// many campaigns it walks, outlives it.
//
// Each press that takes the lock keeps a record of what it is doing and what
// it found (manual-sync-report.ts), which the page polls: the pass runs long
// after the form has answered.

import { and, eq, gt } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { acquireSyncLock, extendSyncLock, heldSyncLocks, releaseSyncLock } from '../sync-lock.js';
import { vanSyncPass, type Caller } from '../scheduler.js';
import { syncLocks, vanCampaigns, vanSyncState } from '../schema.js';
import { campaignName } from './campaigns.js';
import { VAN_LEDGER_LOCK, vanSyncLock } from './locks.js';
import type { CampaignDrain } from './manual-geometry.js';
import { latestManualSync, ManualSyncRecord, type ManualSyncRun } from './manual-sync-report.js';

type Db = LibSQLDatabase<Record<string, unknown>>;

export const MANUAL_VAN_SYNC_LOCK = 'manual:van-sync';
/** A press arrived while one was running: read VAN again. Kept in the lock
 *  table, as a row that is there or not, so it holds across machines like the
 *  lock does. */
export const MANUAL_VAN_RESYNC = 'manual:van-sync:again';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** The lock's life without a heartbeat — how long a crashed press blocks the
 *  next. */
const LOCK_TTL_MS = 2 * MINUTE;
const HEARTBEAT_MS = 30 * SECOND;
/** How often a waiting press looks again for the running sync to finish. */
const WAIT_POLL_MS = 5 * SECOND;
/** The longest a press waits for a running sync. A scheduled pass finishes
 *  well inside this; what holds a campaign lock for longer is a command-line
 *  drain, and the pass then runs anyway and syncs what it can. */
const MAX_WAIT_MS = 15 * MINUTE;
/** A request outlives a crashed holder by this much at most. */
const RESYNC_TTL_MS = 60 * MINUTE;
/** The after-pass's time from the first pass's start, as before resyncs. */
const AFTER_PASS_MS = 30 * MINUTE;
/** What an after-pass gets after a resync, at least: the turf it read wants
 *  its shapes, even when the first drain's time is nearly gone. */
const MIN_AFTER_RESYNC_MS = 10 * MINUTE;
/** No after-pass runs past this, however many resyncs. */
const MAX_RUN_MS = 45 * MINUTE;
/** Passes one press runs, its own included. */
const MAX_PASSES = 4;

export interface AfterPassContext {
	/** When to stop, as a timestamp. */
	deadline: number;
	/** A press asked for VAN to be read again: stop soon, and the pass runs. */
	shouldStop: () => Promise<boolean>;
}

export interface ManualSyncOptions {
	/** Run after each pass, under the same lock. Its failure is logged, never
	 *  thrown. What it returns goes in the press's record. */
	afterPass?: (ctx: AfterPassContext) => Promise<CampaignDrain[] | void>;
	/** Who pressed, for the record. */
	startedByName?: string | null;
	/** For tests. */
	pollMs?: number;
	maxWaitMs?: number;
	heartbeatMs?: number;
	watchSlackMs?: number;
}

export type ManualSyncStart =
	/** `started`: running now. `queued`: a sync was already running, and this
	 *  one runs as soon as it finishes. `done` settles when the press's work
	 *  ends — for tests; the page does not wait on it. */
	| { status: 'started' | 'queued'; done: Promise<void> }
	/** A pressed sync is already running; this press is folded into it, and
	 *  VAN is read again at its next chance. */
	| {
			status: 'joined';
			/** Settles when this press stops watching the holder — for tests. */
			done: Promise<void>;
	  };

/**
 * The VAN sync locks held right now: each enabled campaign's catalog lock, and
 * the ledger lock. The ledger one covers the housekeeping each request does
 * before it takes its campaign's lock — sending any due expiry reminders over
 * Slack, which can take seconds — so the moment between one campaign of a
 * scheduled pass and the next does not read as "finished".
 */
async function vanSyncsRunning(db: Db): Promise<string[]> {
	const enabled = await db
		.select({ id: vanCampaigns.id })
		.from(vanCampaigns)
		.where(eq(vanCampaigns.enabled, true));
	return heldSyncLocks(db, [...enabled.map((c) => vanSyncLock(c.id)), VAN_LEDGER_LOCK]);
}

/** Ask the running press to read VAN again. Already asked is fine. */
async function requestResync(db: Db): Promise<void> {
	await acquireSyncLock(db, MANUAL_VAN_RESYNC, RESYNC_TTL_MS);
}

async function resyncRequested(db: Db): Promise<boolean> {
	return (await heldSyncLocks(db, [MANUAL_VAN_RESYNC])).length > 0;
}

/** Clear the request, saying whether there was one. */
async function takeResync(db: Db): Promise<boolean> {
	const rows = await db
		.delete(syncLocks)
		.where(
			and(eq(syncLocks.name, MANUAL_VAN_RESYNC), gt(syncLocks.expiresAt, new Date().toISOString())),
		)
		.returning({ name: syncLocks.name });
	return rows.length > 0;
}

/** Start a VAN sync pass in the background, or fold this press into the one
 *  already running. */
export async function startManualVanSync(
	db: Db,
	call: Caller,
	options: ManualSyncOptions = {},
): Promise<ManualSyncStart> {
	let token = await acquireSyncLock(db, MANUAL_VAN_SYNC_LOCK, LOCK_TTL_MS);
	if (!token) {
		await requestResync(db);
		// The holder may have finished between the two. Take the lock then,
		// rather than leave the request for a holder that has gone.
		token = await acquireSyncLock(db, MANUAL_VAN_SYNC_LOCK, LOCK_TTL_MS);
		if (!token) {
			const done = answerIfHolderDies(db, call, options).catch((err) =>
				console.error(
					'[van] manual sync: could not watch the running sync:',
					err instanceof Error ? err.message : err,
				),
			);
			return { status: 'joined', done };
		}
	}
	return runHolding(db, call, options, token);
}

/** When the press lock expires, or null when nobody holds it. */
async function holderExpiry(db: Db): Promise<string | null> {
	const [row] = await db
		.select({ expiresAt: syncLocks.expiresAt })
		.from(syncLocks)
		.where(eq(syncLocks.name, MANUAL_VAN_SYNC_LOCK));
	return row?.expiresAt ?? null;
}

/**
 * Watch the press that holds the lock long enough to see it heartbeat. A live
 * one answers our request itself. A dead one never will: wait out its lock,
 * take it, and run.
 */
async function answerIfHolderDies(db: Db, call: Caller, options: ManualSyncOptions): Promise<void> {
	const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
	const before = await holderExpiry(db);
	// Two heartbeats and a little: a live holder has moved its expiry by then.
	await new Promise((r) => setTimeout(r, 2 * heartbeatMs + (options.watchSlackMs ?? 5 * SECOND)));
	const after = await holderExpiry(db);
	if (after !== null && after !== before) return;
	if (after !== null) {
		console.warn('[van] manual sync: the running sync stopped heartbeating; taking over');
		await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(after) - Date.now()) + 50));
	}
	// Released or expired. Whoever takes it first answers the request.
	if (!(await resyncRequested(db))) return;
	const token = await acquireSyncLock(db, MANUAL_VAN_SYNC_LOCK, LOCK_TTL_MS);
	if (token) await (await runHolding(db, call, options, token)).done;
}

/** Everything a press does once it holds the lock. */
async function runHolding(
	db: Db,
	call: Caller,
	options: ManualSyncOptions,
	token: string,
	/** The press's record, when this run carries on for it. */
	carried?: ManualSyncRecord,
): Promise<{ status: 'started' | 'queued'; done: Promise<void> }> {
	const pollMs = options.pollMs ?? WAIT_POLL_MS;
	const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
	const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

	let running: string[];
	try {
		running = await vanSyncsRunning(db);
	} catch (err) {
		await releaseSyncLock(db, MANUAL_VAN_SYNC_LOCK, token);
		throw err;
	}

	const queued = running.length > 0;
	let record: ManualSyncRecord;
	if (carried) {
		record = carried;
		await record.reopen(queued ? 'waiting' : 'reading');
	} else {
		record = await ManualSyncRecord.start(
			db,
			options.startedByName ?? null,
			queued ? 'waiting' : 'reading',
		);
	}
	const heartbeat = setInterval(() => {
		extendSyncLock(db, MANUAL_VAN_SYNC_LOCK, token, LOCK_TTL_MS).catch((err) =>
			console.error('[van] manual sync: could not extend the lock:', err),
		);
	}, heartbeatMs);
	heartbeat.unref();

	const done = (async () => {
		let handOver = false;
		try {
			if (queued) {
				console.log('[van] manual sync: waiting for the running sync to finish');
				// Finished means clear on two looks in a row. A scheduled pass
				// syncs campaigns one request after another, and one look landing
				// between two requests would start this pass on top of the next
				// campaign — whose catalog the endpoint would then skip.
				const until = Date.now() + maxWaitMs;
				let clearLooks = 0;
				while (clearLooks < 2 && Date.now() < until) {
					await new Promise((r) => setTimeout(r, pollMs));
					running = await vanSyncsRunning(db);
					clearLooks = running.length === 0 ? clearLooks + 1 : 0;
				}
			}
			await passes(db, call, options, record);
		} catch (err) {
			console.error('[van] manual sync: failed:', err instanceof Error ? err.message : err);
		} finally {
			clearInterval(heartbeat);
			// A press still waiting — past the last pass — is a fresh run's,
			// under this lock and record. Letting go first would leave the
			// record unfinished beside a free lock, which reads as a press that
			// died.
			try {
				handOver = await resyncRequested(db);
			} catch (err) {
				console.error('[van] manual sync: could not look for a press:', err);
			}
			if (!handOver) {
				// Before the lock goes, for the same reason.
				await record.finish();
				try {
					await releaseSyncLock(db, MANUAL_VAN_SYNC_LOCK, token);
				} catch (err) {
					// The TTL frees it anyway.
					console.error('[van] manual sync: could not release the lock:', err);
				}
			}
		}

		try {
			if (handOver) {
				await (
					await runHolding(db, call, options, token, record)
				).done;
				return;
			}
			// A press between our last look and the release above found the lock
			// held, left its request and went. Nobody would answer it: take it here.
			if (await resyncRequested(db)) {
				const again = await acquireSyncLock(db, MANUAL_VAN_SYNC_LOCK, LOCK_TTL_MS);
				if (again) await (await runHolding(db, call, options, again, record)).done;
			}
		} catch (err) {
			// runHolding let go of the lock: the record must not read as running.
			await record.finish();
			console.error(
				'[van] manual sync: could not answer a late press:',
				err instanceof Error ? err.message : err,
			);
		}
	})();
	return { status: queued ? 'queued' : 'started', done };
}

/** The pass, then the after-pass; again while presses keep asking. */
async function passes(
	db: Db,
	call: Caller,
	options: ManualSyncOptions,
	record: ManualSyncRecord,
): Promise<void> {
	const started = Date.now();
	const hardStop = started + MAX_RUN_MS;
	let deadline = started + AFTER_PASS_MS;
	for (let pass = 1; ; pass++) {
		// This pass reads VAN after every press so far, so it answers them all.
		await takeResync(db);
		console.log(`[van] manual sync: pass ${pass} started`);
		await record.passStarted();
		const passStarted = Date.now();
		try {
			const answers = await vanSyncPass(call, db);
			const failures = answers.filter((a) => a.error !== undefined);
			if (failures.length > 0) {
				console.error(
					'[van] manual sync: failed:',
					failures.map((a) => `campaign ${a.campaignId}: ${a.error}`).join('; '),
				);
			}
			console.log(
				`[van] manual sync: pass ${pass} done in ${Math.round((Date.now() - passStarted) / 1000)}s`,
			);
			await record.pass(answers);
		} catch (err) {
			console.error('[van] manual sync: failed:', err instanceof Error ? err.message : err);
		}

		if (options.afterPass) {
			if (pass > 1) {
				deadline = Math.min(hardStop, Math.max(deadline, Date.now() + MIN_AFTER_RESYNC_MS));
			}
			const after = Date.now();
			await record.phase('shapes');
			try {
				const drained = await options.afterPass({
					deadline,
					shouldStop: () => resyncRequested(db),
				});
				if (drained) await record.drain(drained);
				console.log(
					`[van] manual sync: after-pass done in ${Math.round((Date.now() - after) / 1000)}s`,
				);
			} catch (err) {
				console.error(
					'[van] manual sync: after-pass failed:',
					err instanceof Error ? err.message : err,
				);
			}
		}

		if (!(await resyncRequested(db))) return;
		if (pass >= MAX_PASSES) {
			// Left standing: runHolding takes it up as a fresh run once this one
			// lets go, with its own time.
			console.log(`[van] manual sync: ${MAX_PASSES} passes; starting afresh`);
			return;
		}
	}
}

/** The latest press's record, for the page. */
export function latestManualVanSync(db: Db): Promise<ManualSyncRun | null> {
	return latestManualSync(db, MANUAL_VAN_SYNC_LOCK);
}

export interface CampaignLastSync {
	id: number;
	name: string;
	/** Null before the campaign's first completed sync. */
	lastSyncAt: string | null;
	/** The most recent sync failed. A success clears it (sync.ts). */
	failed: boolean;
}

/** When each enabled campaign's catalog last synced, oldest campaign first. */
export async function lastVanSyncs(db: Db): Promise<CampaignLastSync[]> {
	const rows = await db
		.select({
			id: vanCampaigns.id,
			label: vanCampaigns.label,
			credentialKey: vanCampaigns.credentialKey,
			lastSyncAt: vanSyncState.lastSyncAt,
			lastError: vanSyncState.lastError,
		})
		.from(vanCampaigns)
		.leftJoin(vanSyncState, eq(vanSyncState.campaignId, vanCampaigns.id))
		.where(eq(vanCampaigns.enabled, true))
		.orderBy(vanCampaigns.id);
	return rows.map((r) => ({
		id: r.id,
		name: campaignName(r),
		lastSyncAt: r.lastSyncAt ?? null,
		failed: r.lastError !== null,
	}));
}

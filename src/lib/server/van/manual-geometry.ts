// Map shapes for the organizers' "Sync VAN now" button.
//
// An organizer who cuts turf for a request presses the button and expects it
// on the map. The pass the button runs (manual-sync.ts) is the scheduled one,
// where geometry gets whatever the catalog left of a five-minute request at
// two at a time — often a handful of turfs, and sometimes none. Turf with no
// shape and no centroid is not on the map at all (`mappableTurfs`), so the
// request it was cut for goes unanswered until enough scheduled runs come by.
//
// So after its pass a press keeps draining each campaign's queue until it is
// empty or MAX_DRAIN_MS is up, outside any request: this already runs in the
// background, so it can take the minutes a request cannot. No cap on turfs — a
// press should get through a hundred, and more is better, roster rebuilds
// included. The worker takes turf that is not on the map first
// (geometry-worker.ts), so the organizer's new turf goes before any roster
// rebuild; and campaigns take turns a slice at a time, so one campaign's
// backlog cannot spend the whole drain while another's new turf waits.
//
// Nothing here is lost if the machine stops partway — Fly can stop a second
// machine the press happened to land on once traffic drops, and a deploy
// restarts them all. Rows mid-export stay resumable, the locks expire, and the
// scheduled syncs or the next press carry on.
//
// Under the campaign's sync lock, the one the scheduled sync and VAN's export
// webhook take, in slices like the drain script's: a held lock means two
// drainers would submit two export jobs per turf, and holding it for the whole
// drain would make a scheduled sync starting meanwhile skip its catalog. That
// sync waits 75s for the lock (LOCK_WAIT_MS in the van-sync route) and polls
// every 2s, so a slice holds it for less than that, and the drain pauses
// longer than a poll before taking it again — or the sync would never see it
// free.
//
// Requested turf (van/turf-placement.ts) is placed in its chapter after each
// slice that put turf on the map, so a request shows up where the volunteer
// is looking as soon as it has a shape, not at the next scheduled sync. The
// drain also places whatever requested turf is waiting, shaped by this press
// or not — first, since a backlog of shapes can take the whole drain, and
// again once the shapes are done: a scheduled sync places only what its
// budget reaches, and a folder can hold hundreds.
//
// A press while this runs asks for VAN to be read again (manual-sync.ts). The
// drain checks between slices, stops when asked, and the press runs its pass
// and comes back here.

import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { acquireSyncLock, releaseSyncLock } from '../sync-lock.js';
import { vanCampaigns, type VanCampaignRow } from '../schema.js';
import { vanClientFor, vanExportJobTypeIdFor, vanPersonHasher } from '../van-env.js';
import { loadSettings } from '../settings.js';
import { alertFor } from '../slack.js';
import { APP_URL, INTERNAL_CRON_SECRET } from '../env.js';
import { campaignName } from './campaigns.js';
import { runGeometryQueue, type GeometryWorkerResult } from './geometry-worker.js';
import { vanSyncLock } from './locks.js';
import { exportCallbackUrl } from './webhook-token.js';
import { placeRequestedTurf, type PlacementResult } from './turf-placement.js';
import { placementChapters } from './placement-chapters.js';

type Db = ReturnType<typeof drizzle>;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** When a slice stops starting turfs. With FINISH_GRACE_MS, the most a slice
 *  holds the lock: a minute, inside the 75s a scheduled sync waits for it. */
const SLICE_MS = 30 * SECOND;
/** Turfs already under way finish past the slice rather than being cut off
 *  mid-download, which spends an attempt and throws the export job away. */
const FINISH_GRACE_MS = 30 * SECOND;
/** Between slices, with the lock free: more than a waiting sync's 2s poll, so
 *  it takes the lock before the next slice can. */
const YIELD_MS = 5 * SECOND;
/** Longer than a slice plus its grace, so a crash mid-slice frees it soon. */
const LOCK_TTL_MS = 5 * MINUTE;
/** The longest a slice waits for the lock — a scheduled sync's whole run. */
const LOCK_WAIT_MS = 5 * MINUTE;
const LOCK_POLL_MS = 2 * SECOND;
/** The whole drain, every campaign together. Room for a few hundred turfs at
 *  the worker's usual pace; what it does not reach waits for the next press
 *  or the scheduled syncs. */
const MAX_DRAIN_MS = 30 * MINUTE;
/** Turfs in flight, as the drain script runs it. The VAN client still caps
 *  its own calls at two; this is downloads and geocoding alongside. */
const CONCURRENCY = 4;
/** Placing what a slice shaped: a Census lookup per turf. */
const PLACEMENT_BUDGET_MS = 15 * SECOND;
/** Placing what is waiting, before the shapes and once they are done. */
const WAITING_PLACEMENT_BUDGET_MS = 5 * 60 * SECOND;
/** The longest a press waits for another run's placement: a scheduled
 *  sync's placement, with its lookups in flight. */
const PLACE_BUSY_WAIT_MS = 60 * SECOND;

export interface CampaignDrain {
	campaignId: number;
	/** Turfs picked up across every slice. */
	attempted: number;
	/** Of those, now on the map: a hull or a centroid. */
	mapped: number;
	/** Why it stopped with work possibly left, if it did. */
	stopped?: 'not configured' | 'lock busy' | 'out of time' | 'resync requested';
}

export interface ManualGeometryDeps {
	/** Injected for tests. */
	run?: typeof runGeometryQueue;
	clientFor?: typeof vanClientFor;
	exportJobTypeIdFor?: typeof vanExportJobTypeIdFor;
	lockPollMs?: number;
	lockWaitMs?: number;
	yieldMs?: number;
	maxDrainMs?: number;
	/** When to stop, as a timestamp; MAX_DRAIN_MS from now if omitted. */
	deadline?: number;
	/** Checked between slices: true stops the drain, for a pass to run. */
	shouldStop?: () => Promise<boolean>;
	/** Place a campaign's requested turf; placeRequestedTurf by default. */
	place?: (
		db: Db,
		campaign: VanCampaignRow,
		timeBudgetMs: number,
		retryMisses?: boolean,
		shouldStop?: () => Promise<boolean>,
	) => Promise<PlacementResult | void>;
	/** Between tries while another run holds the placement lock. */
	placeBusyPollMs?: number;
}

async function placeNow(
	db: Db,
	campaign: VanCampaignRow,
	timeBudgetMs: number,
	retryMisses = false,
	shouldStop?: () => Promise<boolean>,
): Promise<PlacementResult> {
	return placeRequestedTurf(db, campaign, {
		chapters: await placementChapters(db),
		timeBudgetMs,
		retryMisses,
		shouldStop,
	});
}

/** One campaign's place in the rotation. */
interface Turn {
	campaign: VanCampaignRow;
	tag: string;
	drained: CampaignDrain;
	client?: Extract<ReturnType<typeof vanClientFor>, { ok: true }>['client'];
	exportJobTypeId?: number;
	/** No more slices for it: its queue is through, or it stopped. */
	done: boolean;
	/** It threw; left out of the result. */
	failed?: true;
}

/**
 * Drain every enabled campaign's queue until each is empty or the time is up,
 * a slice per campaign in turn. Never throws for one campaign: the others
 * still run.
 */
export async function drainGeometryForPress(
	db: Db,
	deps: ManualGeometryDeps = {},
): Promise<CampaignDrain[]> {
	const deadline = deps.deadline ?? Date.now() + (deps.maxDrainMs ?? MAX_DRAIN_MS);
	const campaigns = await db
		.select()
		.from(vanCampaigns)
		.where(eq(vanCampaigns.enabled, true))
		.orderBy(vanCampaigns.id);
	const several = campaigns.length > 1;
	const { slackTurfChannelId } = await loadSettings(db);

	const turns: Turn[] = campaigns.map((campaign) => {
		const turn: Turn = {
			campaign,
			tag: several ? `[van · ${campaignName(campaign)}]` : '[van]',
			drained: { campaignId: campaign.id, attempted: 0, mapped: 0 },
			done: false,
		};
		const exportJobTypeId = (deps.exportJobTypeIdFor ?? vanExportJobTypeIdFor)(campaign);
		const configured = (deps.clientFor ?? vanClientFor)(campaign);
		if (exportJobTypeId === null || !configured.ok) {
			// The scheduled sync already says so in the turf channel.
			turn.drained.stopped = 'not configured';
			turn.done = true;
		} else {
			turn.client = configured.client;
			turn.exportJobTypeId = exportJobTypeId;
		}
		return turn;
	});

	// Before any shapes: what is waiting already has a location, and a long
	// shape queue would otherwise leave it no time at the end. Misses too: the
	// press is how an organizer who fixed what kept a turf out asks for it to
	// be tried again.
	await placeWaiting(db, turns, deadline, deps, true);

	let sliced = false;
	rotation: while (turns.some((t) => !t.done)) {
		for (const turn of turns) {
			if (turn.done) continue;
			if (sliced) await new Promise((r) => setTimeout(r, deps.yieldMs ?? YIELD_MS));
			// Both end the whole drain, not one campaign's turn.
			const stop =
				Date.now() >= deadline
					? ('out of time' as const)
					: (await deps.shouldStop?.())
						? ('resync requested' as const)
						: null;
			if (stop) {
				for (const t of turns) {
					if (!t.done) {
						t.drained.stopped = stop;
						t.done = true;
					}
				}
				break rotation;
			}
			try {
				await takeSlice(db, turn, deadline, deps, slackTurfChannelId);
			} catch (err) {
				console.error(
					`${turn.tag} manual sync: geometry failed:`,
					err instanceof Error ? err.message : err,
				);
				turn.failed = true;
				turn.done = true;
			}
			sliced = true;
		}
	}

	// Not when a resync was asked for: its pass places too, and the drain that
	// follows it comes back here. Not the misses, tried at the start: this is
	// for turf the drain shaped.
	if (!turns.some((t) => t.drained.stopped === 'resync requested')) {
		await placeWaiting(db, turns, deadline, deps, false);
	}

	for (const { tag, drained, failed } of turns) {
		if (failed) continue;
		console.log(
			`${tag} manual sync: ${drained.mapped} of ${drained.attempted} turf(s) put on the map` +
				(drained.stopped ? ` (stopped: ${drained.stopped})` : ''),
		);
	}
	return turns.filter((t) => !t.failed).map((t) => t.drained);
}

/**
 * Place each campaign's waiting requested turf. Needs neither VAN nor the
 * sync lock, so a campaign VAN cannot be read for is placed too. Stops for a
 * resync as the slices do; waits out another run placing the same campaign —
 * a scheduled sync's twenty seconds — rather than leave the press's turf to
 * the next one.
 */
async function placeWaiting(
	db: Db,
	turns: readonly Turn[],
	deadline: number,
	deps: ManualGeometryDeps,
	retryMisses: boolean,
): Promise<void> {
	for (const turn of turns) {
		if (turn.failed || turn.campaign.requestedFolderId === null) continue;
		if (await deps.shouldStop?.()) return;
		const waitUntil = Math.min(deadline, Date.now() + PLACE_BUSY_WAIT_MS);
		try {
			for (;;) {
				const timeBudgetMs = Math.min(WAITING_PLACEMENT_BUDGET_MS, deadline - Date.now());
				if (timeBudgetMs <= 0) return;
				const result = await (deps.place ?? placeNow)(
					db,
					turn.campaign,
					timeBudgetMs,
					retryMisses,
					deps.shouldStop,
				);
				if (result?.busy && Date.now() < waitUntil) {
					await new Promise((r) => setTimeout(r, deps.placeBusyPollMs ?? LOCK_POLL_MS));
					continue;
				}
				if (result) console.log(`${turn.tag} manual sync: requested turf placed:`, result);
				break;
			}
		} catch (err) {
			console.error(
				`${turn.tag} manual sync: placement failed:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
}

/** One slice of one campaign's queue, under its lock. Marks the turn done
 *  once the queue is through or the lock cannot be had. */
async function takeSlice(
	db: Db,
	turn: Turn,
	deadline: number,
	deps: ManualGeometryDeps,
	slackTurfChannelId: string,
): Promise<void> {
	const run = deps.run ?? runGeometryQueue;
	const lock = vanSyncLock(turn.campaign.id);
	const token = await waitForLock(db, lock, deps, deadline);
	if (!token) {
		turn.drained.stopped = 'lock busy';
		turn.done = true;
		return;
	}

	let slice: GeometryWorkerResult;
	try {
		slice = await run(db, turn.client!, {
			campaignId: turn.campaign.id,
			exportJobTypeId: turn.exportJobTypeId!,
			// As the sync builds it: our own host, a per-turf token.
			webhookUrlFor: (turfId) => exportCallbackUrl(APP_URL, INTERNAL_CRON_SECRET, turfId),
			timeBudgetMs: Math.min(SLICE_MS, deadline - Date.now()),
			finishGraceMs: FINISH_GRACE_MS,
			concurrency: CONCURRENCY,
			alert: alertFor(turn.tag, slackTurfChannelId),
			roster: vanPersonHasher(),
		});
	} finally {
		await releaseSyncLock(db, lock, token);
	}

	turn.drained.attempted += slice.attempted;
	turn.drained.mapped += slice.hullsStored + slice.centroidsOnly;
	if (slice.hullsStored + slice.centroidsOnly > 0 && turn.campaign.requestedFolderId !== null) {
		try {
			await (deps.place ?? placeNow)(db, turn.campaign, PLACEMENT_BUDGET_MS);
		} catch (err) {
			// The next slice, or the scheduled sync, places it instead.
			console.error(
				`${turn.tag} manual sync: placement failed:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
	// Nothing left it could start, or it got through the whole queue without
	// the clock stopping it: done, bar jobs VAN is still exporting, which its
	// webhook collects.
	if (slice.attempted === 0 || !slice.budgetLapsed) turn.done = true;
}

async function waitForLock(
	db: Db,
	lock: string,
	deps: ManualGeometryDeps,
	deadline: number,
): Promise<string | null> {
	const pollMs = deps.lockPollMs ?? LOCK_POLL_MS;
	const until = Math.min(Date.now() + (deps.lockWaitMs ?? LOCK_WAIT_MS), deadline);
	let token = await acquireSyncLock(db, lock, LOCK_TTL_MS);
	while (!token && Date.now() < until) {
		await new Promise((r) => setTimeout(r, pollMs));
		token = await acquireSyncLock(db, lock, LOCK_TTL_MS);
	}
	return token;
}

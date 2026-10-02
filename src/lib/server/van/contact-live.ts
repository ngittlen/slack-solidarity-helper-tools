// Where the uncontacted-door count meets configuration: the VAN client, the
// hash secret and the lock. contact-sync.ts takes all of them injected so it
// can be tested against an in-memory database; this resolves them for the two
// callers — the scheduled sync (every turf in one campaign) and the nudge
// after a volunteer marks turf walked (that turf).
//
// Per campaign: each pulls its own ContactHistory with its own key, under its
// own lock, so one campaign's first backfill cannot freeze another's counts.

import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { errMessage } from '../../err-message.js';
import { vanCampaigns, vanTurfs, type VanCampaignRow } from '../schema.js';
import { withSyncLock } from '../sync-lock.js';
import { vanClientFor, vanPersonHasher } from '../van-env.js';
import { clearUncontacted, runContactSync, type ContactSyncResult } from './contact-sync.js';
import { vanContactLock } from './locks.js';
import { nudgePacketTracker } from './packet-tracker-live.js';

type Db = ReturnType<typeof drizzle>;

/** What the stage needs to know about a campaign. */
export type ContactCampaign = Pick<VanCampaignRow, 'id' | 'credentialKey'>;

const LOG = '[van]';
/** Past any run's own budget, so a crashed holder frees it within a cadence. */
const LOCK_TTL_MS = 5 * 60 * 1000;
/** A nudge normally has one short window to read, so this is generous. */
const NUDGE_BUDGET_MS = 30 * 1000;

/** A nudge that finds the lock taken waits this long for it, at most. Past any
 *  holder's own budget (a scheduled run's 45 s, a nudge's 30 s). */
const NUDGE_WAIT_MS = 90 * 1000;
const NUDGE_RETRY_MS = 5 * 1000;

type StageOutcome = { kind: 'off' } | { kind: 'busy' } | { kind: 'ran'; result: ContactSyncResult };

async function attemptContactStage(
	db: Db,
	campaign: ContactCampaign,
	options: { timeBudgetMs: number; turfIds?: readonly number[] },
): Promise<StageOutcome> {
	const hasher = vanPersonHasher();
	// Switched off: drop any count a previous configuration left behind, or it
	// would override VAN's doorCount, and gate claims, frozen forever.
	if (!hasher) {
		await clearUncontacted(db);
		return { kind: 'off' };
	}
	const configured = vanClientFor(campaign);
	if (!configured.ok) return { kind: 'off' };
	const run = await withSyncLock(db, vanContactLock(campaign.id), LOCK_TTL_MS, () =>
		runContactSync(db, configured.client, {
			campaignId: campaign.id,
			hasher,
			timeBudgetMs: options.timeBudgetMs,
			recomputeTurfIds: options.turfIds,
		}),
	);
	return run.skipped ? { kind: 'busy' } : { kind: 'ran', result: run.result };
}

/**
 * Pull one campaign's new contacts and recompute its turf. Null — rather than
 * zeros — when the count is not configured or another run holds the lock, so
 * "off" stays distinguishable from "ran and found nothing".
 */
export async function runContactStage(
	db: Db,
	campaign: ContactCampaign,
	options: { timeBudgetMs: number; turfIds?: readonly number[] },
): Promise<ContactSyncResult | null> {
	const outcome = await attemptContactStage(db, campaign, options);
	return outcome.kind === 'ran' ? outcome.result : null;
}

/** The campaign a turf belongs to, or null for a turf that is gone. */
async function campaignOfTurf(db: Db, turfId: number): Promise<ContactCampaign | null> {
	const [row] = await db
		.select({ id: vanCampaigns.id, credentialKey: vanCampaigns.credentialKey })
		.from(vanTurfs)
		.innerJoin(vanCampaigns, eq(vanCampaigns.id, vanTurfs.campaignId))
		.where(eq(vanTurfs.turfId, turfId));
	return row ?? null;
}

/**
 * The nudge itself, awaitable for tests. Waits out a run already holding the
 * lock rather than giving up on it: that run may be another volunteer's nudge,
 * which recomputes only its own turf, and even a scheduled run may have read
 * ContactHistory before this volunteer's MiniVAN sync landed.
 */
export async function nudgeWithRetry(
	db: Db,
	turfId: number,
	timing: { waitMs?: number; retryMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
	const waitMs = timing.waitMs ?? NUDGE_WAIT_MS;
	const retryMs = timing.retryMs ?? NUDGE_RETRY_MS;
	const sleep = timing.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	// The turf's own campaign: its ContactHistory is the only one that can
	// hold this volunteer's doors.
	const campaign = await campaignOfTurf(db, turfId);
	if (!campaign) return;
	let waited = 0;
	for (;;) {
		const outcome = await attemptContactStage(db, campaign, {
			timeBudgetMs: NUDGE_BUDGET_MS,
			turfIds: [turfId],
		});
		if (outcome.kind === 'off') return;
		if (outcome.kind === 'ran') {
			const { result } = outcome;
			if (result.error) console.warn(`${LOG} contact nudge for ${turfId}:`, result.error);
			// The completion's % walked was just derived; the tracker row the
			// first nudge wrote went out without it.
			if (result.percentsStamped > 0) nudgePacketTracker(db, turfId);
			return;
		}
		if (waited >= waitMs) {
			// Still held after every holder's budget: something is wrong with
			// it, and the scheduled sync will catch this turf up.
			console.warn(`${LOG} contact nudge for ${turfId}: lock still held, leaving it`);
			return;
		}
		await sleep(retryMs);
		waited += retryMs;
	}
}

/**
 * Bring one turf's count up to date in the background, after it is marked
 * walked. Fire-and-forget: the volunteer's reply never waits on VAN.
 *
 * Best-effort by nature: a volunteer who has not synced MiniVAN yet has no
 * contacts in VAN to find, so the scheduled sync (every 30 minutes by day) is
 * what catches the rest.
 */
export function nudgeContactCount(db: Db, turfId: number): void {
	void nudgeWithRetry(db, turfId).catch((err) =>
		console.error(`${LOG} contact nudge failed:`, errMessage(err)),
	);
}

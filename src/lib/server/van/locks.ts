import type { drizzle } from 'drizzle-orm/libsql';
import { heldSyncLocks } from '../sync-lock.js';

type Db = ReturnType<typeof drizzle>;

/**
 * The advisory lock both halves of a campaign's VAN sync take.
 *
 * ONE name per campaign, shared: the catalog sync and the export-job webhook
 * both drain van_geometry_queue, and the queue has no per-row claim, so two
 * drainers racing would each pick up the same turf and each POST /exportJobs.
 * Not hypothetical — VAN's webhook fires while a scheduled run is mid-drain,
 * because the scheduled run is what submitted the job.
 *
 * Per campaign (specs/012-multi-van-campaigns): each campaign's catalog, queue
 * and key are its own, so one campaign's long geometry drain must not hold up
 * another's sync.
 *
 * Its own module so the webhook route need not import the catalog sync, which
 * it otherwise has nothing to do with, to learn a string.
 */
export function vanSyncLock(campaignId: number): string {
	return `van-catalog-sync:${campaignId}`;
}

/**
 * Left by a scheduled sync while it waits for a campaign's vanSyncLock. A
 * drain holding that lock in slices pauses between them only when this is
 * held (scripts/van-geometry-drain.ts) — a pause after every slice was a
 * sixth of the drain's time, for a sync that comes every forty minutes.
 * Short-lived, so a waiter that dies stops holding the drain up on its own.
 */
export function vanSyncWaitingLock(campaignId: number): string {
	return `van-catalog-sync-waiting:${campaignId}`;
}

/** Whether a scheduled sync is waiting for the campaign's vanSyncLock. Yes
 *  when it cannot tell: a pause costs seconds, a skipped sync a cadence. */
export async function vanSyncWaiting(db: Db, campaignId: number): Promise<boolean> {
	try {
		return (await heldSyncLocks(db, [vanSyncWaitingLock(campaignId)])).length > 0;
	} catch {
		return true;
	}
}

/**
 * A campaign's ContactHistory pull and uncontacted-door recompute
 * (contact-sync.ts).
 *
 * Its own name rather than vanSyncLock: it touches only its own cursor and
 * the uncontacted columns, so a volunteer's completion nudge need not wait out
 * a whole catalog sync — and a two-hour roster drain holding the sync lock
 * must not stop the counts moving.
 */
export function vanContactLock(campaignId: number): string {
	return `van-contact-sync:${campaignId}`;
}

/**
 * A campaign's live ContactHistory poll (live-contacts.ts): one machine polls
 * at a time. Not vanContactLock, which the scheduled pull and the completion
 * nudge would then find taken every half minute.
 */
export function vanLiveContactLock(campaignId: number): string {
	return `van-live-contacts:${campaignId}`;
}

/**
 * The ledger housekeeping every van-sync request starts with: expiring lapsed
 * claims, the six-hour warnings, and noticing new campaign secrets. It reads
 * only our own tables and covers every campaign at once, so it takes one lock
 * of its own rather than any campaign's — a request for one campaign must not
 * wait on another campaign's catalog to expire claims.
 */
export const VAN_LEDGER_LOCK = 'van-ledger';

/**
 * Held by a drain while the roster's person index is dropped for its bulk
 * load (roster-index.ts), so the contact pull does not rebuild it underneath.
 * One for every campaign: the index is the whole table's.
 */
export const VAN_ROSTER_BULK_LOCK = 'van-roster-bulk-load';

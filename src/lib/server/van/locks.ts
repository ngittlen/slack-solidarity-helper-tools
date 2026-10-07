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
 * The ledger housekeeping every van-sync request starts with: expiring lapsed
 * claims, the six-hour warnings, and noticing new campaign secrets. It reads
 * only our own tables and covers every campaign at once, so it takes one lock
 * of its own rather than any campaign's — a request for one campaign must not
 * wait on another campaign's catalog to expire claims.
 */
export const VAN_LEDGER_LOCK = 'van-ledger';

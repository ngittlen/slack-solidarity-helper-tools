/**
 * The advisory lock both halves of the VAN sync take.
 *
 * ONE name, shared: the catalog sync and the export-job webhook both drain
 * van_geometry_queue, and the queue has no per-row claim, so two drainers
 * racing would each pick up the same turf and each POST /exportJobs. Not
 * hypothetical — VAN's webhook fires while a scheduled run is mid-drain,
 * because the scheduled run is what submitted the job.
 *
 * Its own module so the webhook route need not import the catalog sync, which
 * it otherwise has nothing to do with, to learn a string.
 */
export const VAN_SYNC_LOCK = 'van-catalog-sync';

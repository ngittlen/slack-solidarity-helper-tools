import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings, loadVanChapterFolders } from '$lib/server/settings.js';
import { acquireSyncLock, releaseSyncLock } from '$lib/server/sync-lock.js';
import { vanClient } from '$lib/server/van-env.js';
import { runCatalogSync } from '$lib/server/van/sync.js';
import { sweepExpiredClaims } from '$lib/server/van/checkout-store.js';
import { INTERNAL_CRON_SECRET } from '$lib/server/env.js';

// VAN turf catalog sync. Called on a schedule (see
// .github/workflows/van-catalog-sync.yml) and by hand during setup.
// Auth via ?key=<INTERNAL_CRON_SECRET>, same as every other internal endpoint.

const LOCK_NAME = 'van-catalog-sync';
// Longer than the sync's own time budget, so a run killed mid-flight by Fly
// still frees the lock within a cadence rather than blocking until someone
// notices.
const LOCK_TTL_MS = 10 * 60 * 1000;

export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[van] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (url.searchParams.get('key') !== INTERNAL_CRON_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const configured = vanClient();
	if (!configured.ok) {
		return json({ error: configured.error }, { status: 500 });
	}

	const token = await acquireSyncLock(db, LOCK_NAME, LOCK_TTL_MS);
	if (!token) {
		// Not an error: overlapping cron attempts are expected (the workflow
		// fires staggered runs), and the second one has nothing to do.
		return json({ skipped: 'another catalog sync is in progress' }, { status: 200 });
	}

	try {
		// Ledger housekeeping first, and independent of VAN: an expired claim
		// needs stamping whether or not the catalog fetch below succeeds, and
		// running it here means it inherits this route's schedule and lock
		// rather than needing a second cron of its own.
		const claimsExpired = await sweepExpiredClaims(db, new Date());
		if (claimsExpired > 0) console.log(`[van] swept ${claimsExpired} expired claim(s)`);

		const mappings = await loadVanChapterFolders(db);
		const result = await runCatalogSync(db, configured.client, mappings);
		console.log(
			`[van] catalog sync: ${result.turfsUpserted} turfs across ${result.foldersSynced} folder(s), ` +
				`${result.turfsRetired} retired, ${result.geometryQueued} queued for geometry`,
			{ skipped: result.foldersSkipped, degraded: result.degraded },
		);

		// Best-effort, exactly as in the door-knock snapshot: a Slack outage
		// must not fail a sync that already wrote its rows.
		const notices = [...result.degraded, ...result.warnings];
		if (notices.length > 0) {
			try {
				const { slackTrackingChannelId } = await loadSettings(db);
				await slack.chat.postMessage({
					channel: slackTrackingChannelId,
					text: `[van] catalog sync notices:\n${notices.map((n) => `• ${n}`).join('\n')}`,
				});
			} catch (err) {
				console.error(
					'[van] failed to post sync notices to Slack:',
					err instanceof Error ? err.message : err,
				);
			}
		}

		return json({ ...result, claimsExpired });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[van] catalog sync failed:', msg);
		return json({ error: msg }, { status: 500 });
	} finally {
		await releaseSyncLock(db, LOCK_NAME, token);
	}
};

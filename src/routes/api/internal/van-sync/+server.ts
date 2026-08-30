import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings, loadVanChapterFolders } from '$lib/server/settings.js';
import { acquireSyncLock, releaseSyncLock } from '$lib/server/sync-lock.js';
import { vanClient } from '$lib/server/van-env.js';
import { runCatalogSync } from '$lib/server/van/sync.js';
import { sweepExpiredClaims } from '$lib/server/van/checkout-store.js';
import { sendExpiryWarnings } from '$lib/server/van/expiry-warning-store.js';
import { INTERNAL_CRON_SECRET } from '$lib/server/env.js';

// VAN turf catalog sync, plus the turf ledger's housekeeping. Called on a
// schedule (see .github/workflows/van-catalog-sync.yml) and by hand during
// setup. Auth via ?key=<INTERNAL_CRON_SECRET>, same as every other internal
// endpoint.
//
// Two halves with different dependencies: expiring lapsed claims and sending
// six-hour warnings need only our own ledger, while the catalog half needs a
// VAN key. The first half therefore runs before the key is checked — see the
// comment in the handler.

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
	const token = await acquireSyncLock(db, LOCK_NAME, LOCK_TTL_MS);
	if (!token) {
		// Not an error: overlapping cron attempts are expected (the workflow
		// fires staggered runs), and the second one has nothing to do.
		return json({ skipped: 'another catalog sync is in progress' }, { status: 200 });
	}

	try {
		// Ledger housekeeping first, and genuinely independent of VAN — which is
		// why it now runs BEFORE the vanClient() check rather than after it. An
		// expired claim needs stamping and a volunteer needs their six-hour
		// warning whether or not the catalog fetch below succeeds, and while a
		// missing key means no new turf, it does not mean the turf volunteers are
		// already holding stops mattering. Rotate the key badly on a Friday and
		// the old order silently stopped both for the whole weekend.
		//
		// Running here also means both inherit this route's schedule and lock
		// rather than needing a second cron of their own.
		const now = new Date();
		const claimsExpired = await sweepExpiredClaims(db, now);
		if (claimsExpired > 0) console.log(`[van] swept ${claimsExpired} expired claim(s)`);

		// Sweep first, then warn: the sweep releases anything already past its
		// TTL, so nobody is warned about turf that expired moments ago.
		const warnings = await sendExpiryWarnings(db, now);

		// The catalog half needs VAN. Still a 500 so a misconfigured key is
		// visible in the workflow run rather than passing quietly.
		const configured = vanClient();
		if (!configured.ok) {
			return json(
				{
					error: configured.error,
					claimsExpired,
					expiryWarningsSent: warnings.sent,
					expiryWarningsFailed: warnings.failed,
				},
				{ status: 500 },
			);
		}

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

		return json({
			...result,
			claimsExpired,
			expiryWarningsSent: warnings.sent,
			expiryWarningsFailed: warnings.failed,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[van] catalog sync failed:', msg);
		return json({ error: msg }, { status: 500 });
	} finally {
		await releaseSyncLock(db, LOCK_NAME, token);
	}
};

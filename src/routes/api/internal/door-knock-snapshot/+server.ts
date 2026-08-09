import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings } from '$lib/server/settings.js';
import { runDoorKnockSnapshot } from '$lib/server/door-knock-snapshot.js';
import { doorKnockProvider } from '$lib/server/door-knock-env.js';
import { beginDoorKnockRefresh, endDoorKnockRefresh } from '$lib/server/door-knock-refresh.js';
import { INTERNAL_CRON_SECRET } from '$lib/server/env.js';

// Internal endpoint called by a scheduler near the end of the canvassing day
// (Openfield's leaderboard is today-only, so this freezes today's totals).
// Auth via ?key=<INTERNAL_CRON_SECRET>, same as the solidarity snapshot.
export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[door-knock] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (url.searchParams.get('key') !== INTERNAL_CRON_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const configured = doorKnockProvider();
	if (!configured.ok) {
		return json({ error: configured.error }, { status: 500 });
	}

	// The scheduled run always runs — but it still resets the dashboard's
	// on-demand refresh window (door-knock-refresh.ts) so a visit right after
	// the cron doesn't immediately re-fetch the same numbers.
	await beginDoorKnockRefresh(db, new Date());

	try {
		const result = await runDoorKnockSnapshot(db, configured.provider);
		await endDoorKnockRefresh(db, new Date(), null);
		console.log(
			`[door-knock] ${result.provider} ${result.date}: ${result.rowsWritten} rows, ` +
				`${result.totalAttempts} attempts`,
			result.details,
		);

		// Providers raise a warning only for conditions that need a human — for
		// Openfield, codes its parser couldn't attribute to a chapter (counted
		// under "Unmapped"). Routine conditions like a mid-day code swap are
		// logged by the provider and never reach here. Best-effort: a Slack
		// outage must not fail the snapshot that already ran.
		if (result.warnings.length > 0) {
			try {
				const { slackTrackingChannelId } = await loadSettings(db);
				for (const text of result.warnings) {
					await slack.chat.postMessage({ channel: slackTrackingChannelId, text });
				}
			} catch (err) {
				console.error(
					'[door-knock] failed to post provider warning to Slack:',
					err instanceof Error ? err.message : err,
				);
			}
		}

		return json(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[door-knock] failed:', msg);
		await endDoorKnockRefresh(db, new Date(), msg);
		return json({ error: msg }, { status: 500 });
	}
};

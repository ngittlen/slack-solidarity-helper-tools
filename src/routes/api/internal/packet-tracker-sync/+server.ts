import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings } from '$lib/server/settings.js';
import { runPacketTracker } from '$lib/server/van/packet-tracker-live.js';
import { INTERNAL_CRON_SECRET } from '$lib/server/env.js';
import { secretMatches } from '$lib/server/secret-compare.js';

// The Packet Tracker (specs/011-turf-checkout-sheet), on its own schedule: our
// checkouts written into each campaign's spreadsheets, and the campaign's own
// entries read back, which is what keeps turf an organizer handed out by hand
// off the map. Called by the in-process scheduler every 15 minutes.
// Auth via ?key=<INTERNAL_CRON_SECRET>.
//
// It used to run last in the VAN sync, on whatever time the VAN stages left of
// that request. A slow VAN call left it none, and the map went on offering
// turf the trackers said was out — the claim's live check refused each one as
// a volunteer tried it. No VAN call here, so VAN being slow cannot starve it.
//
// The tracker's own lock keeps a run from overlapping a nudge (or itself); a
// run that finds it held skips, and the holder is doing the same work.

// A run reads every spreadsheet the campaigns route to — seventy-odd, one read
// each, plus a re-read of each row before it is written. The Sheets client
// paces them at 45 a minute (the rest of Google's 60 is the claims' live
// checks'), so seventy-odd take a little over a minute; this leaves room for
// the writes. Well inside the tracker lock's three minutes
// (packet-tracker-live.ts), which nothing renews: the budget stops new
// spreadsheets, not the one under way, and a run past the lock could write a
// row a nudge is writing too. The order is shuffled each run, so whatever one
// run does not reach, the next does.
const BUDGET_MS = 100 * 1000;

export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[sheets] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (!secretMatches(url.searchParams.get('key'), INTERNAL_CRON_SECRET)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const { slackTurfChannelId } = await loadSettings(db);
		const result = await runPacketTracker(db, {
			timeBudgetMs: BUDGET_MS,
			channelId: slackTurfChannelId,
		});
		// Advisory — an unrouted region, a row the campaign edited. Failures that
		// need an operator are posted by the tracker itself through postAlert,
		// one message per ongoing problem.
		const warnings = result?.warnings ?? [];
		if (warnings.length > 0 && slackTurfChannelId) {
			try {
				await slack.chat.postMessage({
					channel: slackTurfChannelId,
					text: `[sheets] Packet Tracker notices:\n${warnings.map((n) => `• ${n}`).join('\n')}`,
				});
			} catch (err) {
				console.error(
					'[sheets] failed to post Packet Tracker notices to Slack:',
					err instanceof Error ? err.message : err,
				);
			}
		}
		if (result && (result.budgetLapsed || result.deferred > 0)) {
			console.log('[sheets] packet tracker stopped early; the rest wait for the next run', {
				deferred: result.deferred,
			});
		}
		// Null: not configured, no campaign has rules, or a nudge holds the lock.
		return json(result ?? { skipped: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[sheets] packet tracker failed:', msg);
		return json({ error: msg }, { status: 500 });
	}
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { runSolidarityAttendeeSync } from '$lib/server/attendee-sync.js';
import { alertForMobilizeSync } from '$lib/server/slack.js';
import { INTERNAL_CRON_SECRET, MOBILIZE_API_KEY, SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { withSyncLock } from '$lib/server/sync-lock.js';

const SYNC_LOCK_NAME = 'attendee-sync';

// Must exceed the longest plausible run or the lock expires mid-sync and lets a
// second run in — the race this closes. The windowless nightly pass is the long
// one, and the workflow already allows it 50 minutes of curl before giving up
// (the server keeps working past that), so 90 gives real headroom. The cost of
// erring high is only that a crashed run blocks the next pass for that long,
// which the 30-minute cadence absorbs.
const SYNC_LOCK_TTL_MS = 90 * 60 * 1000;

// Mirrors Mobilize signups into Solidarity as event RSVPs, so organizers only
// have to look in one place. Auth via ?key=<INTERNAL_CRON_SECRET>.
//
//   ?dry=1            plan and report without writing
//   ?window=4.5       only sessions starting within N hours (omit for all upcoming)
//   ?lookback=48      also include sessions that started within N hours (default 48)
//   ?maxProfiles=N    raise the new-profile guardrail
//
// Two cadences: every 30 minutes with a 4.5h look-ahead so organizers have
// accurate lists before doors open, and nightly with no window so events further
// out still get a rolling picture in Solidarity.
//
// The lookback matters as much as the window — check-ins are recorded during and
// after an event, so a forward-only scope would never sync who actually showed.

export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[attendee-sync] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (url.searchParams.get('key') !== INTERNAL_CRON_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Bound after auth so an unauthenticated request can never trigger a post.
	const alert = await alertForMobilizeSync('attendee-sync', db);
	if (!SOLIDARITY_API_TOKEN) {
		return json({ error: 'SOLIDARITY_API_TOKEN is not set' }, { status: 500 });
	}
	if (!MOBILIZE_API_KEY) {
		await alert(':warning: Attendee sync is not configured — MOBILIZE_API_KEY is unset.');
		return json({ error: 'MOBILIZE_API_KEY is not set' }, { status: 500 });
	}

	const dryRun = url.searchParams.get('dry') === '1';
	const windowParam = url.searchParams.get('window');
	const windowHours = windowParam ? Number(windowParam) : undefined;
	if (windowParam && !Number.isFinite(windowHours)) {
		return json({ error: `invalid window: ${windowParam}` }, { status: 400 });
	}
	const lookbackParam = url.searchParams.get('lookback');
	const lookbackHours = lookbackParam ? Number(lookbackParam) : undefined;
	if (lookbackParam && !Number.isFinite(lookbackHours)) {
		return json({ error: `invalid lookback: ${lookbackParam}` }, { status: 400 });
	}
	const maxParam = url.searchParams.get('maxProfiles');
	const maxNewProfiles = maxParam ? parseInt(maxParam, 10) : undefined;

	try {
		const run = await withSyncLock(db, SYNC_LOCK_NAME, SYNC_LOCK_TTL_MS, () =>
			runSolidarityAttendeeSync(db, {
				apply: !dryRun,
				windowHours,
				lookbackHours,
				maxNewProfiles,
			}),
		);

		// 200 rather than 409 on purpose. The every-30-minutes pass routinely
		// overlaps the windowless nightly one, which can run for the better part
		// of an hour — that is expected, not a failure, and the workflow uses
		// `curl --fail-with-body`, so a 4xx would turn a normal skip into a red
		// run and train everyone to ignore the alerts. No Slack post either.
		if (run.skipped) {
			console.log('[attendee-sync] skipped — another sync is already running');
			return json({ skipped: true, reason: 'another attendee sync is already running' });
		}
		const result = run.result;

		// Deliberately count-only: this data is people's emails and phone numbers,
		// and these logs go to Fly and Slack.
		console.log(
			`[attendee-sync]${dryRun ? ' (dry)' : ''} window=${result.windowHours ?? 'all'} ` +
				`lookback=${result.lookbackHours}h events ${result.events}, timeslots ${result.timeslots}, ` +
				`signups ${result.participations}: ` +
				`rsvps +${result.rsvpsCreated}/~${result.rsvpsUpdated}, profiles +${result.profilesCreated}, ` +
				`matched ${result.matchedByEmail}e/${result.matchedByPhone}p, unchanged ${result.unchanged}, ` +
				`no-contact ${result.skippedNoContact}, unknown-status ${result.skippedUnknownStatus}, ` +
				`failed ${result.failed}`,
		);

		if (result.authFailed) {
			await alert(
				':rotating_light: *Attendee sync stopped — Mobilize rejected the API key.*\n' +
					'Signups are no longer reaching Solidarity. Check that `MOBILIZE_API_KEY` is set on the ' +
					'Fly app and still has write access, then run ' +
					"`fly secrets set MOBILIZE_API_KEY='<key>'`.",
			);
		} else if (result.abortedReason) {
			await alert(`:warning: *Attendee sync aborted.* ${result.abortedReason}`);
		} else if (!dryRun && (result.rsvpsCreated > 0 || result.profilesCreated > 0)) {
			await alert(
				`:busts_in_silhouette: Attendee sync: ${result.rsvpsCreated} new RSVP(s), ` +
					`${result.rsvpsUpdated} updated, ${result.profilesCreated} new Solidarity profile(s) ` +
					`across ${result.timeslots} shift(s).`,
			);
		}

		if (result.skippedUnknownStatus > 0) {
			await alert(
				`:grey_question: Attendee sync saw ${result.skippedUnknownStatus} signup(s) with an ` +
					'unrecognized Mobilize status and skipped them rather than guessing. Worth a look — ' +
					'it likely means a status code we have not mapped yet.',
			);
		}
		if (result.failed > 0) {
			await alert(
				`:warning: Attendee sync had ${result.failed} failure(s):\n` +
					result.errors
						.slice(0, 5)
						.map((e) => `• ${e}`)
						.join('\n'),
			);
		}

		const status = result.authFailed || result.abortedReason ? 503 : 200;
		return json(result, { status });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[attendee-sync] failed:', msg);
		await alert(`:x: Attendee sync failed: ${msg}`);
		return json({ error: msg }, { status: 500 });
	}
};

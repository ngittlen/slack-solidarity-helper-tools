import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { runMobilizeImport } from '$lib/server/mobilize-import.js';
import { alertForMobilizeSync } from '$lib/server/slack.js';
import { INTERNAL_CRON_SECRET, SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { withSyncLock } from '$lib/server/sync-lock.js';
import { mrkdwnLink } from '$lib/slack-mrkdwn.js';
import { secretMatches } from '$lib/server/secret-compare.js';

// Internal endpoint the scheduler calls hourly to copy a partner campaign's
// tagged Mobilize events into Solidarity. Auth via ?key=<INTERNAL_CRON_SECRET>.
//
//   ?dry=1        plan and report without writing
//   ?maxCreates=N raise the create guardrail for a deliberate bulk run
//   ?budgetMs=N   override how long one request may spend before it stops
//
// Create-only and idempotent: a Turso ledger records each import the moment
// the Solidarity event exists, so repeated runs finish or skip rather than
// duplicate. Alerts go to the Mobilize sync channel.

const LOCK_NAME = 'mobilize-import';
const LOCK_TTL_MS = 10 * 60 * 1000;
const LOG = '[mobilize-import]';

export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error(`${LOG} INTERNAL_CRON_SECRET is not set`);
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (!secretMatches(url.searchParams.get('key'), INTERNAL_CRON_SECRET)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const alert = await alertForMobilizeSync('mobilize-import', db);
	if (!SOLIDARITY_API_TOKEN) {
		return json({ error: 'SOLIDARITY_API_TOKEN is not set' }, { status: 500 });
	}

	const dryRun = url.searchParams.get('dry') === '1';
	// Validated for the same reason as mobilize-sync's: NaN would not raise the
	// limit, it would delete it.
	const maxCreatesParam = url.searchParams.get('maxCreates');
	const maxCreates = maxCreatesParam ? Number(maxCreatesParam) : undefined;
	if (maxCreatesParam && (!Number.isInteger(maxCreates) || maxCreates! < 0)) {
		return json({ error: `invalid maxCreates: ${maxCreatesParam}` }, { status: 400 });
	}
	const budgetParam = url.searchParams.get('budgetMs');
	const budgetMs = budgetParam ? Number(budgetParam) : undefined;
	if (budgetParam && (!Number.isInteger(budgetMs) || budgetMs! <= 0)) {
		return json({ error: `invalid budgetMs: ${budgetParam}` }, { status: 400 });
	}

	try {
		const run = await withSyncLock(db, LOCK_NAME, LOCK_TTL_MS, () =>
			runMobilizeImport(db, { apply: !dryRun, maxCreates, budgetMs }),
		);
		if (run.skipped) {
			console.log(`${LOG} skipped — another import is already running`);
			return json({ skipped: true, reason: 'another Mobilize import is already running' });
		}
		const result = run.result;

		// Opt-in feature: an unconfigured install answers 200 every hour, quietly.
		if (!result.configured) {
			console.log(`${LOG} not configured — ${result.reason}`);
			return json({ skipped: true, reason: result.reason });
		}

		console.log(
			`${LOG}${dryRun ? ' (dry)' : ''} planned ${result.planned}: created ${result.created}, ` +
				`resumed ${result.resumed}, unchanged ${result.unchanged}, ` +
				`duplicates ${result.duplicates.length}, not-public ${result.skippedNotPublic}, ` +
				`not-owned ${result.skippedNotOwned}, stalled ${result.stalled.length}, ` +
				`failed ${result.failed}` +
				(dryRun
					? `, would create ${result.wouldCreate.length}, would finish ${result.wouldResume.length}`
					: '') +
				(result.incomplete ? `, INCOMPLETE — ${result.pending} not reached` : ''),
		);

		if (result.mobilizeAuthFailed) {
			await alert(
				':rotating_light: *Partner Mobilize import stopped — their Mobilize rejected the API key.*\n' +
					'No partner events are being imported. Check `MOBILIZE_IMPORT_API_KEY` and ' +
					'`MOBILIZE_IMPORT_ORG_ID` on the Fly app.',
			);
		} else if (result.authFailed) {
			await alert(
				':rotating_light: *Partner Mobilize import stopped — Solidarity rejected the API token.*\n' +
					result.errors.slice(0, 1).join(''),
			);
		} else if (result.abortedReason) {
			await alert(
				`:warning: *Partner Mobilize import held back new events.* ${result.abortedReason}\n` +
					'No new events were created (earlier half-finished imports still were). Check the ' +
					'tag on /settings, then re-run with `?maxCreates=N` if the number is right.',
			);
		}
		if (!dryRun && (result.created > 0 || result.resumed > 0)) {
			const lines = [
				`:inbox_tray: Partner Mobilize import: imported ${result.created}` +
					(result.resumed > 0 ? `, finished ${result.resumed} from an earlier run` : '') +
					'.' +
					(result.incomplete ? ` Still working — ${result.pending} to go.` : ''),
				...result.createdEvents
					.slice(0, 10)
					.map((e) => `• new: ${e.pageUrl ? mrkdwnLink(e.pageUrl, e.title) : e.title}`),
			];
			if (result.createdEvents.length > 10) {
				lines.push(`• …and ${result.createdEvents.length - 10} more`);
			}
			await alert(lines.join('\n'));
		}

		// Named on their own: each one needs someone to move it to the right
		// chapter by hand. Virtual events never appear here.
		if (!dryRun && result.fallbackScope.length > 0) {
			await alert(
				`:round_pushpin: *Partner Mobilize import — ${result.fallbackScope.length} in-person ` +
					'event(s) filed under the default chapter* because their zip matched no chapter:\n' +
					result.fallbackScope
						.slice(0, 10)
						.map((t) => `• ${t}`)
						.join('\n'),
			);
		}

		// The match is not always someone else's event: a create whose reply was
		// lost to a network error leaves the event in Solidarity unrecorded, and
		// the retry is then refused as a duplicate of it. That copy has no page
		// or extra shifts, so the alert has to send someone to look.
		if (result.duplicates.length > 0) {
			await alert(
				`:twisted_rightwards_arrows: Partner Mobilize import — Solidarity refused ` +
					`${result.duplicates.length} event(s) as duplicates, so they were not imported ` +
					'and will not be retried. The match may be an event someone already made, or an ' +
					'earlier attempt of this same import that was cut off by a network error. Find ' +
					'each one in Solidarity and check that it has its page and all its shifts:\n' +
					result.duplicates
						.slice(0, 10)
						.map((t) => `• ${t}`)
						.join('\n'),
			);
		}

		// Loud, because only a person can fix it: the event is almost certainly in
		// Solidarity with no page, and retrying would create a second one.
		if (result.unconfirmed.length > 0) {
			await alert(
				`:rotating_light: *Partner Mobilize import — Solidarity accepted ` +
					`${result.unconfirmed.length} event(s) but didn't say what it created.* They are ` +
					'probably in Solidarity without sessions or a page. Find each one in the dashboard ' +
					'and finish it by hand; the import will not retry them:\n' +
					result.unconfirmed
						.slice(0, 10)
						.map((t) => `• ${t}`)
						.join('\n'),
			);
		}

		if (result.rejected.length > 0) {
			await alert(
				`:no_entry: Partner Mobilize import — gave up on ${result.rejected.length} event(s) ` +
					'that Solidarity refused 3 times (see the earlier failure alerts for why). They ' +
					'will not be retried:\n' +
					result.rejected
						.slice(0, 10)
						.map((r) =>
							r.solidarityEventId === null
								? `• ${r.title} — not imported`
								: `• ${r.title} — *already in Solidarity* as event ${r.solidarityEventId}, ` +
									'but unfinished (page or shifts missing); finish or remove it by hand',
						)
						.join('\n'),
			);
		}

		if (result.newlyStalled.length > 0) {
			await alert(
				`:construction: Partner Mobilize import — ${result.newlyStalled.length} half-finished ` +
					'import(s) can no longer be finished: in Mobilize the event was untagged or made ' +
					'private, or has no open upcoming shifts left. Each is in Solidarity without all its sessions ' +
					'or its page — finish or remove it by hand:\n' +
					result.newlyStalled
						.slice(0, 10)
						.map((t) => `• ${t}`)
						.join('\n'),
			);
		}

		if (result.failed > 0) {
			await alert(
				`:warning: Partner Mobilize import had ${result.failed} failure(s). They retry next ` +
					'run, and an event Solidarity keeps refusing is given up on after a few tries:\n' +
					result.errors
						.slice(0, 5)
						.map((e) => `• ${e}`)
						.join('\n'),
			);
		}

		const stopped = result.mobilizeAuthFailed || result.authFailed || result.abortedReason;
		return json(result, { status: stopped ? 503 : 200 });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`${LOG} failed:`, msg);
		await alert(`:x: Partner Mobilize import failed: ${msg}`);
		return json({ error: msg }, { status: 500 });
	}
};

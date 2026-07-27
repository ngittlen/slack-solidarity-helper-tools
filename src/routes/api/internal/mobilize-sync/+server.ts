import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { runMobilizeSync } from '$lib/server/mobilize-sync.js';
import { alertForGrowthChannel } from '$lib/server/slack.js';
import {
	INTERNAL_CRON_SECRET,
	MOBILIZE_COOKIE,
	SOLIDARITY_API_TOKEN,
} from '$lib/server/env.js';

// Internal endpoint called nightly by GitHub Actions to mirror upcoming
// Solidarity events into Mobilize. Auth via ?key=<INTERNAL_CRON_SECRET>.
//
//   ?dry=1        plan and report without writing
//   ?maxCreates=N raise the create guardrail for a deliberate bulk run
//
// Idempotent: a Turso ledger records every event created, so repeated runs
// update rather than duplicate. Safe to fire several times a night, which
// matters because GitHub cron is best-effort (see door-knock-snapshot.yml).

export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[mobilize-sync] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (url.searchParams.get('key') !== INTERNAL_CRON_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Bound after auth so an unauthenticated request can never trigger a post.
	const alert = await alertForGrowthChannel('mobilize-sync', db);
	if (!SOLIDARITY_API_TOKEN) {
		return json({ error: 'SOLIDARITY_API_TOKEN is not set' }, { status: 500 });
	}
	if (!MOBILIZE_COOKIE) {
		await alert(
			':warning: Mobilize sync is not configured — MOBILIZE_COOKIE is unset, so no events are being mirrored.',
		);
		return json({ error: 'MOBILIZE_COOKIE is not set' }, { status: 500 });
	}

	const dryRun = url.searchParams.get('dry') === '1';
	const maxCreatesParam = url.searchParams.get('maxCreates');
	const maxCreates = maxCreatesParam ? parseInt(maxCreatesParam, 10) : undefined;

	try {
		const result = await runMobilizeSync(db, { apply: !dryRun, maxCreates });
		console.log(
			`[mobilize-sync]${dryRun ? ' (dry)' : ''} planned ${result.planned}: ` +
				`created ${result.created}, updated ${result.updated}, unchanged ${result.unchanged}, ` +
				`existing ${result.skippedExisting}, no-address ${result.skippedNoAddress}, failed ${result.failed}`,
		);

		// The borrowed session is the one failure that always needs a human.
		if (result.sessionExpired) {
			await alert(
				':rotating_light: *Mobilize sync stopped — session expired.*\n' +
					'New events are no longer being mirrored from Solidarity. To fix: log in to the Mobilize ' +
					'dashboard, copy the `Cookie` header from any request (DevTools → Network), then run ' +
					'`fly secrets set MOBILIZE_COOKIE=\'<cookie>\'`.',
			);
		} else if (result.abortedReason) {
			await alert(
				`:warning: *Mobilize sync aborted.* ${result.abortedReason}\n` +
					'Nothing was created. Re-run with `?maxCreates=N` once the plan looks right.',
			);
		} else if (!dryRun && (result.created > 0 || result.updated > 0)) {
			const lines = [
				`:calendar: Mobilize sync: created ${result.created}, updated ${result.updated}.`,
				...result.createdTitles.slice(0, 10).map((t) => `• new: ${t}`),
			];
			if (result.createdTitles.length > 10) {
				lines.push(`• …and ${result.createdTitles.length - 10} more`);
			}
			await alert(lines.join('\n'));
		}

		if (result.failed > 0) {
			await alert(
				`:warning: Mobilize sync had ${result.failed} failure(s):\n` +
					result.errors.slice(0, 5).map((e) => `• ${e}`).join('\n'),
			);
		}

		// Surface a stopped sync as a non-200 so the workflow run goes red too.
		const status = result.sessionExpired || result.abortedReason ? 503 : 200;
		return json(result, { status });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[mobilize-sync] failed:', msg);
		await alert(`:x: Mobilize sync failed: ${msg}`);
		return json({ error: msg }, { status: 500 });
	}
};

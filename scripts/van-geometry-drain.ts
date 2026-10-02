/**
 * Drain van_geometry_queue in one long run, from the command line.
 *
 * Same worker the scheduled sync uses (`runGeometryQueue`), with the one thing
 * a Fly request cannot give it: time. The endpoint budgets ~3 minutes per run
 * because it runs inside an HTTP request on a machine that auto-stops, so a
 * first catalog sync of a statewide cut — a couple of thousand turfs, one VAN
 * export job each — takes about a day of scheduled runs to render as shapes.
 * This finishes it in one sitting.
 *
 * It takes the campaign's sync lock, the same lock the endpoint takes. That is the whole
 * safety story: without it a cron run could pick up the same queue rows this is
 * working on and submit a second export job for each. The lock is taken per
 * one-minute slice, not for the whole run: the first roster pass is hours of
 * exports, and holding the lock that long would make every scheduled sync skip
 * — no expired claims swept, no warnings sent. A slice that finds the lock
 * taken waits for the sync to finish and carries on.
 *
 * With VAN_ID_HASH_SECRET set, each export also builds the turf's roster for
 * the uncontacted-door count; `npm run van:sync` first queues every turf that
 * lacks one. The run then ends by pulling VAN's ContactHistory up to now and
 * recounting every turf — even when nothing was queued — so `van:sync` then
 * `van:drain` leaves the doors-left numbers current.
 *
 * Usage (from project root):
 *   npm run van:drain                      # 30 minutes, 2 at a time
 *   npm run van:drain -- --minutes 60
 *   npm run van:drain -- --concurrency 4   # raise if VAN is keeping up
 *   npm run van:drain -- --max 50          # a taste, then stop
 *
 * Stop it with Ctrl-C: the lock is released, the row being worked stays
 * resumable (it already has its export job id), and nothing is lost.
 *
 * One campaign per run: `--campaign <key>` (default `primary`) — its key, its
 * queue, its lock (scripts/campaign-arg.ts). Its export job type is the one on
 * its van_campaigns row, or for `primary` VAN_EXPORT_JOB_TYPE_ID as a fallback.
 *
 * Required env vars:
 *   VAN_CAMPAIGN_<KEY>, or for `primary` the legacy VAN_APP_NAME, VAN_API_KEY,
 *   VAN_DATABASE_MODE (and VAN_EXPORT_JOB_TYPE_ID if the row has none);
 *   APP_URL, INTERNAL_CRON_SECRET, VAN_ID_HASH_SECRET (optional: rosters),
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless the URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import { createVanClient } from '../src/lib/server/van/client.js';
import { runGeometryQueue } from '../src/lib/server/van/geometry-worker.js';
import { vanContactLock, vanSyncLock } from '../src/lib/server/van/locks.js';
import { PRIMARY_CAMPAIGN_KEY } from '../src/lib/server/van/campaign-credentials.js';
import { campaignCredential, campaignKeyArg, campaignRow } from './campaign-arg.js';
import { acquireSyncLock, releaseSyncLock } from '../src/lib/server/sync-lock.js';
import { exportCallbackUrl } from '../src/lib/server/van/webhook-token.js';
import { createPersonHasher } from '../src/lib/server/van/person-hash.js';
import { rosterProgress, runContactSync } from '../src/lib/server/van/contact-sync.js';
import { loadGeometryProgress } from '../src/lib/server/van/geometry-progress-store.js';
import { percentShaped } from '../src/lib/van/geometry-progress.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return fallback;
	const value = Number(args[i + 1]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};

const MINUTES = flag('minutes', 30);
const CONCURRENCY = flag('concurrency', 2);
// `|| null` so `--max` with a junk value means "no cap" rather than "do nothing".
const MAX_ITEMS = args.includes('--max') ? flag('max', 0) || null : null;
/** Work is done in slices so the run reports progress as it goes, rather than
 *  going quiet for half an hour. Each slice is one `runGeometryQueue` call. */
const SLICE_MS = 60 * 1000;

const CAMPAIGN_KEY = campaignKeyArg(args);
const credential = campaignCredential(CAMPAIGN_KEY);
const legacyExportJobTypeId = Number(process.env.VAN_EXPORT_JOB_TYPE_ID ?? '');
const appUrl = process.env.APP_URL ?? '';
const cronSecret = process.env.INTERNAL_CRON_SECRET ?? '';
const hashSecret = process.env.VAN_ID_HASH_SECRET ?? '';
const roster = hashSecret ? createPersonHasher(hashSecret) : null;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

// VAN requires an HTTPS webhook on POST /exportJobs and rejects the request
// without one, so this is a hard requirement rather than a nicety — even though
// every job here is polled rather than waited for.
if (!appUrl.startsWith('https://')) fail('APP_URL must be an https:// URL for the export webhook.');
if (!cronSecret) fail('INTERNAL_CRON_SECRET must be set — it signs the per-turf webhook token.');

const db = drizzle(createClient(dbConfig));
const client = createVanClient({
	appName: credential.appName,
	apiKey: credential.apiKey,
	databaseMode: credential.databaseMode,
});

/** Set by main() once the campaign row is read. */
let campaignId = 0;

/** Lock TTL for one slice, with room for the slice to overrun a little. */
const LOCK_TTL_MS = 3 * SLICE_MS;
/** Pause after each slice, longer than the sync route's lock poll. */
const SLICE_GAP_MS = 10 * 1000;
/** How long to wait for a scheduled sync to let go of the lock. */
const LOCK_RETRY_MS = 15 * 1000;

const totals = {
	attempted: 0,
	hullsStored: 0,
	centroidsOnly: 0,
	noGeometry: 0,
	geocodedFromAddress: 0,
	retried: 0,
	deadLettered: 0,
	hullsTooLarge: 0,
	rostersStored: 0,
	rostersUnavailable: 0,
};

/**
 * Pull VAN's ContactHistory up to now and recompute every turf's uncontacted
 * doors — what the scheduled sync does ~45 seconds at a time, done here in one
 * sitting so that van:sync followed by van:drain leaves the counts current.
 * Takes the contact pull's own lock, not the sync lock, per call.
 */
async function pullContacts(deadline: number, isStopping: () => boolean): Promise<void> {
	if (!roster) return;
	console.log('\nContacts — pulling VAN ContactHistory up to now');
	// Always leave room for this, even if the drain used the whole budget.
	const until = Math.max(deadline, Date.now() + 15 * 60 * 1000);
	let windows = 0;
	let contacts = 0;
	while (!isStopping() && Date.now() < until) {
		const token = await acquireSyncLock(db, vanContactLock(campaignId), 3 * SLICE_MS);
		if (!token) {
			console.log('  … a scheduled sync is pulling contacts; waiting for it');
			await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
			continue;
		}
		let result: Awaited<ReturnType<typeof runContactSync>>;
		try {
			result = await runContactSync(db, client, {
				campaignId,
				hasher: roster,
				timeBudgetMs: Math.min(SLICE_MS, until - Date.now()),
			});
		} finally {
			await releaseSyncLock(db, vanContactLock(campaignId), token);
		}
		windows += result.windowsApplied;
		contacts += result.contactsRead;
		console.log(
			`  through ${result.cursor ?? '—'} · +${result.windowsApplied} day(s), ` +
				`${result.contactsRead} contacts · ${result.turfsRecomputed} turfs recounted` +
				(result.error ? ` · ${result.error}` : ''),
		);
		// Caught up: nothing applied, and no export job left waiting on VAN.
		if (result.windowsApplied === 0 && !result.pending) {
			if (result.error) console.log('  Stopped on the error above; the scheduled sync will retry.');
			break;
		}
		if (result.pending) await new Promise((r) => setTimeout(r, 5_000));
	}
	console.log(`  ${windows} day window(s), ${contacts} in-person contact(s) read.`);
}

async function main(): Promise<void> {
	const campaign = await campaignRow(db, CAMPAIGN_KEY);
	campaignId = campaign.id;
	const exportJobTypeId =
		campaign.exportJobTypeId ??
		(CAMPAIGN_KEY === PRIMARY_CAMPAIGN_KEY && legacyExportJobTypeId > 0
			? legacyExportJobTypeId
			: null);
	if (exportJobTypeId === null) {
		fail(
			`No export job type for ${CAMPAIGN_KEY} — set it on the campaign` +
				(CAMPAIGN_KEY === PRIMARY_CAMPAIGN_KEY ? ' or in VAN_EXPORT_JOB_TYPE_ID' : '') +
				' (5 = VoterCircle on the primary key).',
		);
	}
	console.log(`\nGeometry drain — ${dbConfig.url}`);
	console.log(`Campaign: ${campaign.label ?? CAMPAIGN_KEY} (id ${campaign.id})`);
	console.log(
		`VAN app: ${credential.appName}, mode ${credential.databaseMode}, export job type ${exportJobTypeId}`,
	);
	console.log(roster ? 'Rosters: on' : 'Rosters: off (VAN_ID_HASH_SECRET unset)');
	console.log(
		`Budget: ${MINUTES} min · ${CONCURRENCY} at a time${MAX_ITEMS ? ` · max ${MAX_ITEMS} item(s)` : ''}\n`,
	);

	const before = await loadGeometryProgress(db);
	console.log(
		`  Starting at ${percentShaped(before)}% — ${before.shaped} shaped, ${before.pending} queued, ${before.failed} failed\n`,
	);
	if (before.pending === 0) {
		console.log('  Nothing queued. Run npm run van:sync first if turf is missing shapes.');
		await pullContacts(Date.now() + MINUTES * 60 * 1000, () => false);
		console.log('');
		return;
	}

	// Ctrl-C releases the lock rather than leaving it to expire; whatever row is
	// mid-flight keeps its export job id and resumes on the next run.
	let stopping = false;
	const onSignal = () => {
		if (stopping) return;
		stopping = true;
		console.log('\n  Stopping after this slice…');
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	const deadline = Date.now() + MINUTES * 60 * 1000;
	try {
		let slice = 0;
		while (!stopping && Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const token = await acquireSyncLock(db, vanSyncLock(campaignId), LOCK_TTL_MS);
			if (!token) {
				console.log('  … a scheduled sync holds the lock; waiting for it');
				await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
				continue;
			}
			let result: Awaited<ReturnType<typeof runGeometryQueue>>;
			try {
				result = await runGeometryQueue(db, client, {
					campaignId,
					exportJobTypeId,
					webhookUrlFor: (turfId) => exportCallbackUrl(appUrl, cronSecret, turfId),
					timeBudgetMs: Math.min(SLICE_MS, remaining),
					concurrency: CONCURRENCY,
					maxItems: MAX_ITEMS,
					roster,
					// No Slack alert: an operator is watching this run, and the
					// channel does not need a line per dead letter from a backfill.
				});
			} finally {
				await releaseSyncLock(db, vanSyncLock(campaignId), token);
			}
			// Let a scheduled sync in. It polls for the lock while this holds it,
			// and without a pause the next slice re-takes the lock before the
			// sync's next poll — every scheduled sync then skips for the whole
			// drain, which is what froze the counts during the first roster pass.
			if (!stopping) await new Promise((r) => setTimeout(r, SLICE_GAP_MS));
			totals.rostersStored += result.rostersStored;
			totals.rostersUnavailable += result.rostersUnavailable;

			totals.attempted += result.attempted;
			totals.hullsStored += result.hullsStored;
			totals.centroidsOnly += result.centroidsOnly;
			totals.noGeometry += result.noGeometry;
			totals.geocodedFromAddress += result.geocodedFromAddress;
			totals.retried += result.retried;
			totals.deadLettered += result.deadLettered;
			totals.hullsTooLarge += result.hullsTooLarge;

			slice += 1;
			const progress = await loadGeometryProgress(db);
			console.log(
				`  [${String(slice).padStart(3)}] +${String(result.hullsStored).padStart(3)} hulls · ` +
					`${percentShaped(progress)}% · ${progress.shaped}/${progress.eligible} shaped · ` +
					`${progress.pending} left · +${result.rostersStored} rosters` +
					`${result.deadLettered > 0 ? ` · ${result.deadLettered} dead-lettered` : ''}`,
			);
			for (const line of result.deadLetters) console.log(`        ${line}`);

			// Nothing attempted means the queue is empty — or every row left is
			// one this run already failed, which retrying now will not fix.
			if (result.attempted === 0 || progress.pending === 0) break;
			if (MAX_ITEMS) break;
		}
		await pullContacts(deadline, () => stopping);
	} finally {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
	}

	const after = await loadGeometryProgress(db);
	console.log('\nDone');
	console.log(`  turfs attempted     ${totals.attempted}`);
	console.log(`  hulls stored        ${totals.hullsStored}`);
	console.log(`  centroid only       ${totals.centroidsOnly}   (drawn as a pin, by design)`);
	console.log(`  no geometry at all  ${totals.noGeometry}`);
	console.log(`  geocoded by address ${totals.geocodedFromAddress}`);
	console.log(`  retried             ${totals.retried}`);
	console.log(`  dead-lettered       ${totals.deadLettered}`);
	console.log(`  rosters built       ${totals.rostersStored}`);
	if (totals.rostersUnavailable > 0) {
		console.log(
			`  no roster (no VanID) ${totals.rostersUnavailable}   (check VAN_EXPORT_JOB_TYPE_ID is type 5)`,
		);
	}
	if (totals.hullsTooLarge > 0) {
		console.log(`  implausibly large   ${totals.hullsTooLarge}   (stored, but worth a look)`);
	}
	console.log(
		`\n  Now at ${percentShaped(after)}% — ${after.shaped}/${after.eligible} shaped, ` +
			`${after.pending} queued, ${after.failed} failed.`,
	);
	if (roster) {
		const rosters = await rosterProgress(db);
		console.log(`  Rosters: ${rosters.rostered}/${rosters.live} live turfs.`);
	}
	console.log('  npm run van:geometry shows this any time.\n');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

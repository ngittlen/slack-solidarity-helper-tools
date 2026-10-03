import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { postAlert, slack } from '$lib/server/slack.js';
import { loadSettings, loadVanChapterFolders } from '$lib/server/settings.js';
import { acquireSyncLock, releaseSyncLock } from '$lib/server/sync-lock.js';
import type { VanCampaignRow } from '$lib/server/schema.js';
import {
	ensureCampaignRows,
	vanClientFor,
	vanExportJobTypeIdFor,
	vanPersonHasher,
} from '$lib/server/van-env.js';
import {
	campaignName,
	campaignsStalestFirst,
	loadCampaign,
	markFailureAnnounced,
	recordSyncFailure,
	regionRefreshAllowed,
	severalCampaignsEnabled,
} from '$lib/server/van/campaigns.js';
import type { VanClient } from '$lib/server/van/client.js';
import { runContactStage } from '$lib/server/van/contact-live.js';
import { runCatalogSync } from '$lib/server/van/sync.js';
import { VAN_LEDGER_LOCK, vanSyncLock } from '$lib/server/van/locks.js';
import { runGeometryQueue } from '$lib/server/van/geometry-worker.js';
import { exportCallbackUrl } from '$lib/server/van/webhook-token.js';
import { sweepExpiredClaims } from '$lib/server/van/checkout-store.js';
import { sendExpiryWarnings } from '$lib/server/van/expiry-warning-store.js';
import { sendDriftAlerts } from '$lib/server/van/drift-alert-store.js';
import { sendListExpiryAlerts } from '$lib/server/van/list-expiry-alert-store.js';
import { runRefreshSweep, settleRefreshes } from '$lib/server/van/refresh.js';
import { reconcileClaims } from '$lib/server/van/reconcile-store.js';
import { runPacketTracker } from '$lib/server/van/packet-tracker-live.js';
import { stampDoorDeltas } from '$lib/server/van/door-delta-store.js';
import { doorsHealthWarning } from '$lib/server/van/doors-store.js';
import { alertFor } from '$lib/server/slack.js';
import { APP_URL, INTERNAL_CRON_SECRET } from '$lib/server/env.js';
import { secretMatches } from '$lib/server/secret-compare.js';

// VAN turf catalog sync, plus the turf ledger's housekeeping. Called on a
// schedule (src/lib/server/scheduler.ts, with
// .github/workflows/van-catalog-sync.yml as a backup) and by hand during setup.
// Auth via ?key=<INTERNAL_CRON_SECRET>, same as every other internal
// endpoint.
//
// Two halves with different dependencies: expiring lapsed claims and sending
// six-hour warnings need only our own ledger, while the catalog half needs a
// VAN key. The first half therefore runs before any key is checked — see the
// comment in the handler.
//
// There can be several VAN campaigns (specs/012-multi-van-campaigns), each with
// its own key, folders, lock and state. `?campaign=<id>` syncs that one; the
// scheduler calls it once per enabled campaign. With no campaign named — the
// GitHub workflow — every enabled campaign is synced, stalest first, for as
// long as the request budget lasts. One campaign failing never stops another.

// The workflow calls this with `curl --max-time 300`, so the whole request —
// catalog plus geometry — has to finish inside five minutes or the run is
// recorded as a failure however much work it actually did. Budget 4m30s and
// split it: the catalog first, because turf nobody can see is worse than turf
// drawn as a pin, then whatever is left goes to geometry.
const REQUEST_BUDGET_MS = 4 * 60 * 1000 + 30 * 1000;
const CATALOG_BUDGET_MS = 3 * 60 * 1000;
// A request working through several campaigns starts another only with this
// much left. Less, and the catalog would skip folders and report them as
// failures; the campaign is better left whole for the next run, where it will
// be the stalest and go first.
const MIN_CAMPAIGN_BUDGET_MS = 60 * 1000;
// The refresh sweep sends at most a handful of POSTs and each returns
// immediately — VAN does the re-cut afterwards on its own time. It gets its own
// slice ahead of geometry rather than sharing geometry's leftovers: a sweep
// that never runs means door counts that never move, which is the whole point
// of the feature, while a geometry run cut short is a turf drawn as a pin.
const REFRESH_BUDGET_MS = 30 * 1000;
// Below this there is no point starting a turf we cannot finish — the export
// job would be submitted and then abandoned mid-download.
const MIN_GEOMETRY_BUDGET_MS = 20 * 1000;
// The Packet Tracker's slice. A run is two reads per spreadsheet the campaign
// keeps plus a write per turf that moved, each well under a second — but Google
// can be slow or unreachable without anybody noticing, so it is capped rather
// than trusted to finish. What it does not reach waits for the next run.
const SHEET_BUDGET_MS = 30 * 1000;
// The ContactHistory pull and uncontacted-door recompute. Normally one short
// window (the half hour since the last run) plus a recompute of every turf;
// during the first backfill it walks as many day-windows as fit, and the rest
// wait for the next run.
const CONTACT_BUDGET_MS = 45 * 1000;
const MIN_CONTACT_BUDGET_MS = 10 * 1000;
// Below this there is no point starting: the reads alone need a few seconds,
// and anything unwritten is no worse off waiting.
const MIN_SHEET_BUDGET_MS = 5 * 1000;
// Longer than the sync's own time budget, so a run killed mid-flight by Fly
// still frees the lock within a cadence rather than blocking until someone
// notices.
const LOCK_TTL_MS = 10 * 60 * 1000;
// The housekeeping is a few small writes; a crashed holder frees it quickly.
const LEDGER_LOCK_TTL_MS = 2 * 60 * 1000;
// How long to wait for a campaign's lock before giving up on its catalog. A
// roster or geometry drain run from the command line holds it in one-minute
// slices with a pause between them (scripts/van-geometry-drain.ts), so this
// outlasts one slice. Counted against REQUEST_BUDGET_MS, which the catalog's
// own budget leaves room for.
const LOCK_WAIT_MS = 75 * 1000;
const LOCK_POLL_MS = 2 * 1000;

type Campaign = VanCampaignRow;

/**
 * Drain one campaign's geometry queue with whatever time its catalog left.
 *
 * Returns null — rather than throwing or reporting zeros — when geometry
 * cannot run at all, so "not configured" stays distinguishable from "ran and
 * found nothing to do". A key without an export job type id still syncs a
 * perfectly good catalog; only the shapes are missing.
 */
async function runGeometry(
	campaign: Campaign,
	client: VanClient,
	queued: number,
	requestDeadline: number,
	logPrefix: string,
): Promise<Awaited<ReturnType<typeof runGeometryQueue>> | null> {
	const exportJobTypeId = vanExportJobTypeIdFor(campaign);
	if (exportJobTypeId === null) {
		if (queued > 0) {
			console.warn(
				`${logPrefix} ${queued} turf(s) queued for geometry but no export job type is set — ` +
					'they will render as pins until it is configured (5 = VoterCircle on the primary key)',
			);
		}
		return null;
	}
	const timeBudgetMs = requestDeadline - Date.now();
	if (timeBudgetMs < MIN_GEOMETRY_BUDGET_MS) {
		console.warn(`${logPrefix} skipping geometry this run — the catalog used the request budget`);
		return null;
	}

	try {
		const { slackTurfChannelId } = await loadSettings(db);
		return await runGeometryQueue(db, client, {
			campaignId: campaign.id,
			exportJobTypeId,
			// VAN requires this and posts the finished job to it, so it must be
			// our own host. It carries a per-turf HMAC rather than
			// INTERNAL_CRON_SECRET: VAN stores this string forever and echoes it
			// back on every read of the job, and that secret opens seven other
			// internal endpoints. See webhook-token.ts.
			webhookUrlFor: (turfId) => exportCallbackUrl(APP_URL, INTERNAL_CRON_SECRET, turfId),
			timeBudgetMs,
			alert: alertFor(logPrefix, slackTurfChannelId),
			// Null when VAN_ID_HASH_SECRET is unset: no roster, VanID unread.
			roster: vanPersonHasher(),
			// `geocode` deliberately omitted: the worker defaults to the Census
			// batch geocoder, which fires only for rows VAN left without
			// coordinates.
		});
	} catch (err) {
		// Geometry is decoration. A failure here must not fail a sync whose
		// catalog rows are already written and correct.
		console.error(`${logPrefix} geometry queue failed:`, err instanceof Error ? err.message : err);
		return null;
	}
}

/**
 * Bring the campaign's Packet Tracker up to date, and read back which turf it
 * has handed out itself.
 *
 * Returns null — rather than zeros — when the tracker cannot run at all, so
 * "not configured" stays distinguishable from "ran and found nothing to do".
 * Most deployments of this tool have no campaign spreadsheet, and an
 * integration nobody set up must be silent rather than reassuring.
 */
async function runSheetLog(
	requestDeadline: number,
	channelId: string,
): Promise<Awaited<ReturnType<typeof runPacketTracker>>> {
	const timeBudgetMs = Math.min(SHEET_BUDGET_MS, requestDeadline - Date.now());
	if (timeBudgetMs < MIN_SHEET_BUDGET_MS) {
		console.warn('[sheets] skipping the Packet Tracker this run — the catalog used the budget');
		return null;
	}
	try {
		// Null too when a nudge holds the lock: it is doing this same work, for
		// one turf, and the next scheduled run catches up on the rest.
		return await runPacketTracker(db, { timeBudgetMs, channelId });
	} catch (err) {
		// The tracker is a copy. A failure here must not fail a sync whose own
		// rows are already written and correct — the ledger keeps what is owed
		// and the next run retries it.
		console.error('[sheets] packet tracker failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

interface Housekeeping {
	claimsExpired: number;
	expiryWarningsSent: number;
	expiryWarningsFailed: number;
	/** True when another request held the ledger lock and is doing this. */
	ledgerSkipped?: true;
}

/**
 * The ledger half: expire lapsed claims, send six-hour warnings, and notice new
 * campaign secrets. Needs no VAN key and covers every campaign at once.
 *
 * Runs before any catalog, and genuinely independent of VAN. An expired claim
 * needs stamping and a volunteer needs their six-hour warning whether or not a
 * catalog fetch succeeds, and while a missing key means no new turf, it does
 * not mean the turf volunteers are already holding stops mattering. Rotate a
 * key badly on a Friday and an order that checked the key first silently
 * stopped both for the whole weekend.
 *
 * Under its own lock rather than any campaign's: the scheduler calls this
 * endpoint once per campaign, and each call starting here must not queue
 * behind another campaign's long catalog to do work that takes a second. A
 * request that finds it taken skips it — the holder is doing the same work.
 */
async function runHousekeeping(now: Date): Promise<Housekeeping> {
	const token = await acquireSyncLock(db, VAN_LEDGER_LOCK, LEDGER_LOCK_TTL_MS);
	if (!token) {
		return {
			claimsExpired: 0,
			expiryWarningsSent: 0,
			expiryWarningsFailed: 0,
			ledgerSkipped: true,
		};
	}
	try {
		const claimsExpired = await sweepExpiredClaims(db, now);
		if (claimsExpired > 0) console.log(`[van] swept ${claimsExpired} expired claim(s)`);

		// Sweep first, then warn: the sweep releases anything already past its
		// TTL, so nobody is warned about turf that expired moments ago.
		const warnings = await sendExpiryWarnings(db, now);

		// A campaign secret added since the last tick gets its (disabled)
		// van_campaigns row, ready to configure in /settings. Bookkeeping only —
		// it makes no VAN call and must never fail the sync.
		try {
			const created = await ensureCampaignRows(db, now);
			if (created.length > 0) {
				console.log(`[van] new campaign secret(s), added disabled: ${created.join(', ')}`);
			}
		} catch (err) {
			console.error('[van] campaign discovery failed:', err instanceof Error ? err.message : err);
		}

		return {
			claimsExpired,
			expiryWarningsSent: warnings.sent,
			expiryWarningsFailed: warnings.failed,
		};
	} finally {
		await releaseSyncLock(db, VAN_LEDGER_LOCK, token);
	}
}

/**
 * Record a campaign's failure and, when it is one a person has to fix, say so
 * once in the turf channel.
 *
 * Announced: a malformed secret, which will be malformed on the next run too.
 * Not announced: a campaign with no secret at all — an install that never set
 * VAN up has always run quietly with a 500 — and anything thrown mid-sync,
 * which is a database error: the catalog catches VAN's errors folder by folder
 * and reports them as sync notices, a rejected key included, as it always has.
 */
async function failCampaign(
	campaign: Campaign,
	error: string,
	announce: boolean,
	logPrefix: string,
): Promise<void> {
	console.error(`${logPrefix} catalog sync failed:`, error);
	try {
		const isNew = await recordSyncFailure(db, campaign.id, error);
		if (!announce || !isNew) return;
		const { slackTurfChannelId } = await loadSettings(db);
		if (!slackTurfChannelId) return;
		const posted = await postAlert(
			slackTurfChannelId,
			`${logPrefix} VAN sync for ${campaignName(campaign)} is failing and needs attention: ${error}`,
			logPrefix,
		);
		if (posted) await markFailureAnnounced(db, campaign.id, error);
	} catch (err) {
		console.error(
			`${logPrefix} could not record the failure:`,
			err instanceof Error ? err.message : err,
		);
	}
}

type CampaignOutcome = { failed: boolean; body: Record<string, unknown> };

/**
 * One campaign's catalog sync and everything that rides on it, under that
 * campaign's lock and with that campaign's key.
 */
async function syncCampaign(
	campaign: Campaign,
	requestDeadline: number,
	now: Date,
	named: boolean,
): Promise<CampaignOutcome> {
	// A single-campaign install's messages read exactly as they always have;
	// with several, each names the campaign it is about.
	const logPrefix = named ? `[van · ${campaignName(campaign)}]` : '[van]';
	const lock = vanSyncLock(campaign.id);

	let token = await acquireSyncLock(db, lock, LOCK_TTL_MS);
	const waitUntil = Math.min(Date.now() + LOCK_WAIT_MS, requestDeadline - MIN_CAMPAIGN_BUDGET_MS);
	while (!token && Date.now() < waitUntil) {
		await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
		token = await acquireSyncLock(db, lock, LOCK_TTL_MS);
	}
	if (!token) {
		// Not an error: overlapping cron attempts are expected (the workflow
		// fires staggered runs), and the second one has nothing to do.
		//
		// The uncontacted-door counts still move. They take their own lock, so
		// a drain holding this one for hours — as the first roster pass did,
		// leaving every count frozen — cannot stop them.
		let contacts: Awaited<ReturnType<typeof runContactStage>> = null;
		try {
			contacts = await runContactStage(db, campaign, {
				timeBudgetMs: Math.min(CONTACT_BUDGET_MS, requestDeadline - Date.now()),
			});
		} catch (err) {
			console.error(`${logPrefix} contact sync failed:`, err instanceof Error ? err.message : err);
		}
		return {
			failed: false,
			body: {
				campaignId: campaign.id,
				skipped: 'another catalog sync is in progress',
				contacts: contacts ?? { disabled: true },
			},
		};
	}

	try {
		// Still a 500 for the request when a campaign has no usable key, so a
		// misconfiguration is visible in the workflow run rather than passing
		// quietly.
		const configured = vanClientFor(campaign);
		if (!configured.ok) {
			await failCampaign(campaign, configured.error, !configured.missing, logPrefix);
			return { failed: true, body: { campaignId: campaign.id, error: configured.error } };
		}
		const client = configured.client;

		const mappings = await loadVanChapterFolders(db, campaign.id);
		const result = await runCatalogSync(db, client, campaign.id, mappings, {
			timeBudgetMs: Math.min(CATALOG_BUDGET_MS, requestDeadline - Date.now()),
			// Queue roster exports only when something can build them.
			roster: vanPersonHasher() !== null,
		});
		console.log(
			`${logPrefix} catalog sync: ${result.turfsUpserted} turfs across ${result.foldersSynced} folder(s), ` +
				`${result.turfsRetired} retired, ${result.geometryQueued} queued for geometry`,
			{ skipped: result.foldersSkipped, degraded: result.degraded },
		);

		// Story 4's confirmation half. The catalog read is the only place VAN's
		// `dateRefreshed` shows up, so a refresh we asked for on an earlier tick
		// is confirmed here, using the read that already happened.
		const refreshesSettled = await settleRefreshes(db, campaign.id, result.regionsRead);

		// Reconciliation, before the drift report and before geometry: it is the
		// half of Story 4.5 that touches volunteers. A re-cut region has just
		// retired somebody's route and released their claim (the catalog did that
		// atomically), and this is what pairs the dead route to its replacement,
		// hands it back, and says so. Drift then reads a settled ledger rather
		// than one mid-repair.
		//
		// This and the stages below it up to the refresh read only our own
		// tables, across every campaign; their matching is campaign-scoped, and
		// each is idempotent, so running them after each campaign's catalog
		// does the same work once and nothing twice.
		// One read for both: the reconciliation needs the claim TTL and the drift
		// alert needs the channel, and they run back to back.
		const { vanTurfClaimTtlHours, slackTurfChannelId: turfChannelId } = await loadSettings(db);
		const reconciled = await reconcileClaims(db, {
			now,
			appUrl: APP_URL,
			ttlHours: vanTurfClaimTtlHours,
		});

		// Story 5.6: the sync-back check. After the reconciliation, because that
		// is what releases claims a re-cut invalidated — verifying those as
		// completions would measure a delta against turf that no longer exists.
		const doorDeltas = await stampDoorDeltas(db, { now, appUrl: APP_URL });

		// Story 9.4's health check, and the biggest risk in the canvassing board:
		// every doors number depends on map regions being cut with a "not yet
		// contacted" filter, which nothing in this codebase can enforce. A week of
		// completions that cleared nothing is the only signal we get, and it rides
		// out with the sync's other notices.
		let doorsWarning: string | null = null;
		try {
			doorsWarning = await doorsHealthWarning(db, now);
		} catch (err) {
			console.error(
				`${logPrefix} doors health check failed:`,
				err instanceof Error ? err.message : err,
			);
		}

		// Story 8.2's report, pushed instead of pulled. After the catalog because
		// the catalog writes VAN's half of the comparison (`van_distributed_to`),
		// and before geometry because geometry is the half that gets cut short by
		// the time budget — an unannounced collision costs more than a missing hull.
		const drift = await sendDriftAlerts(db, {
			now,
			channelId: turfChannelId,
			appUrl: APP_URL,
		});

		// MiniVAN list numbers that expire within five days. After the catalog,
		// which is what records each list's creation date — and it makes no VAN
		// call, so it runs whatever the time budget says.
		const listExpiry = await sendListExpiryAlerts(db, {
			now,
			channelId: turfChannelId,
			appUrl: APP_URL,
		});

		// Ask VAN to re-cut what is due (Story 4.2/4.4). Last of the VAN calls
		// that matter, because its effect lands on a later tick: the POST returns
		// straight away and the new counts arrive with a future catalog read.
		//
		// Only for a campaign that has agreed to it (regionRefreshAllowed): its
		// own switch, off unless an admin turns it on. A re-cut replaces every
		// route in the region and deletes its printed lists (verified
		// 2026-09-24) — the replacements are unclaimable until someone prints
		// lists in VAN by hand (see van_campaigns.refreshEnabled). Completed turf
		// still records its want while this is off; the sweep sends it once the
		// switch is on.
		const refresh = regionRefreshAllowed(campaign)
			? await runRefreshSweep(db, client, campaign.id, {
					now,
					timeBudgetMs: Math.min(REFRESH_BUDGET_MS, requestDeadline - Date.now()),
				})
			: null;

		// Uncontacted doors for every turf in this campaign. After the catalog,
		// which writes each turf's cut date and retires dead routes; before the
		// Packet Tracker, which reads the % walked this derives for recent
		// completions; and before geometry, which is the stage that routinely
		// runs out of time. Never fails the sync — the counts are an overlay on
		// VAN's doorCount, which is already written.
		let contacts: Awaited<ReturnType<typeof runContactStage>> = null;
		const contactBudget = Math.min(CONTACT_BUDGET_MS, requestDeadline - Date.now());
		if (contactBudget >= MIN_CONTACT_BUDGET_MS) {
			try {
				contacts = await runContactStage(db, campaign, { timeBudgetMs: contactBudget });
				if (contacts?.error) console.warn(`${logPrefix} contact sync:`, contacts.error);
			} catch (err) {
				console.error(
					`${logPrefix} contact sync failed:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		// The campaign's Packet Tracker (specs/011-turf-checkout-sheet).
		//
		// After the catalog and the reconciliation, and that ordering matters:
		// the catalog is what notices a list loaded in MiniVAN (Status Out, Time
		// Departed), and a re-cut has just released somebody's claim and inserted
		// a replacement — syncing before that ran would write rows describing a
		// ledger mid-repair.
		//
		// Before geometry because geometry is the piece that routinely gets cut
		// short, and a campaign staffer watching their sheet notices a missing
		// row sooner than anyone notices a turf drawn as a pin. It needs no VAN
		// call, so it is unaffected by a missing or rate-limited key.
		const sheetLog = await runSheetLog(requestDeadline, turfChannelId);

		// Geometry runs after the catalog because the catalog is what fills the
		// queue: a turf cut minutes ago gets its shape on this run rather than
		// the next one. It is also the half that is safe to cut short — an
		// unfinished queue is turf rendered as a pin, and the rows stay
		// resumable, whereas an unfinished catalog is turf nobody can see.
		const geometry = await runGeometry(
			campaign,
			client,
			result.geometryQueued,
			requestDeadline,
			logPrefix,
		);

		// Best-effort, exactly as in the door-knock snapshot: a Slack outage
		// must not fail a sync that already wrote its rows.
		// `geometry.warnings` carries advisory notes only. Dead letters are in
		// `geometry.deadLetters`, which runGeometryQueue has already posted through
		// its own `alert` — including them here would put each one in the channel
		// twice.
		const notices = [
			...result.degraded,
			...result.warnings,
			...(refresh?.warnings ?? []),
			...(doorsWarning ? [doorsWarning] : []),
			...(geometry?.warnings ?? []),
			// `sheetLog.warnings` is advisory — an unrouted region, a row the
			// campaign edited. Failures that need an operator are posted by the tracker
			// itself through postAlert, which is what keeps them to one message
			// per ongoing problem; including them here would say it twice.
			...(sheetLog?.warnings ?? []),
		];
		if (notices.length > 0) {
			try {
				const { slackTurfChannelId } = await loadSettings(db);
				await slack.chat.postMessage({
					channel: slackTurfChannelId,
					text: `${logPrefix} catalog sync notices:\n${notices.map((n) => `• ${n}`).join('\n')}`,
				});
			} catch (err) {
				console.error(
					`${logPrefix} failed to post sync notices to Slack:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		return {
			failed: false,
			body: {
				campaignId: campaign.id,
				...result,
				geometry,
				drift,
				listExpiry,
				refreshesSettled,
				reconciled,
				doorDeltas,
				doorsWarning,
				refresh: refresh ?? { disabled: true },
				sheetLog: sheetLog ?? { disabled: true },
				contacts: contacts ?? { disabled: true },
			},
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await failCampaign(campaign, msg, false, logPrefix);
		return { failed: true, body: { campaignId: campaign.id, error: msg } };
	} finally {
		await releaseSyncLock(db, lock, token);
	}
}

export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[van] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (!secretMatches(url.searchParams.get('key'), INTERNAL_CRON_SECRET)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	// Stamped before ANY work, the wait for a lock included. Taking it later
	// would give the request `REQUEST_BUDGET_MS` on top of however long that
	// took, which is precisely the overrun the budget exists to prevent.
	const requestDeadline = Date.now() + REQUEST_BUDGET_MS;

	const campaignParam = url.searchParams.get('campaign');
	const campaignId = campaignParam === null ? null : Number(campaignParam);
	if (campaignId !== null && (!Number.isInteger(campaignId) || campaignId <= 0)) {
		return json({ error: 'campaign must be a positive integer' }, { status: 400 });
	}

	try {
		const now = new Date();
		const housekeeping = await runHousekeeping(now);

		let campaigns: Campaign[];
		if (campaignId !== null) {
			const campaign = await loadCampaign(db, campaignId);
			if (!campaign) return json({ error: `No campaign ${campaignId}` }, { status: 404 });
			if (!campaign.enabled) {
				return json({ ...housekeeping, campaigns: [], skipped: 'campaign is disabled' });
			}
			campaigns = [campaign];
		} else {
			campaigns = await campaignsStalestFirst(db);
		}

		const named = await severalCampaignsEnabled(db);
		const outcomes: CampaignOutcome[] = [];
		const deferred: number[] = [];
		for (const campaign of campaigns) {
			// The first campaign always runs — a request that syncs nothing is no
			// use to anyone. After that, only with enough time left to finish.
			if (outcomes.length > 0 && requestDeadline - Date.now() < MIN_CAMPAIGN_BUDGET_MS) {
				deferred.push(campaign.id);
				continue;
			}
			outcomes.push(await syncCampaign(campaign, requestDeadline, now, named));
		}
		if (deferred.length > 0) {
			console.log(`[van] out of time; campaign(s) ${deferred.join(', ')} left for the next run`);
		}

		const failed = outcomes.some((o) => o.failed);
		return json(
			{
				...housekeeping,
				campaigns: outcomes.map((o) => o.body),
				...(deferred.length > 0 ? { deferred } : {}),
			},
			{ status: failed ? 500 : 200 },
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[van] sync failed:', msg);
		return json({ error: msg }, { status: 500 });
	}
};

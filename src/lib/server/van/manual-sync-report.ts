// What a "Sync VAN now" press did, for the organizer who pressed it.
//
// The press runs in the background for up to the better part of an hour
// (manual-sync.ts), and all the page used to say was "Sync started — reload
// to check". An organizer whose new turf did not appear could not tell a sync
// still running from one that had failed, or from one that ran fine but never
// saw the turf: cut into the wrong folder, held until midnight, or with no
// shape to place it by. So the press keeps a record — which stage it is in,
// each campaign's catalog outcome, how the map shapes went — and
// /turfs/organizer polls it while it runs.
//
// One row per press, in the database: the press runs on whichever machine
// took the form, and the poll may land on another. Written a few times a pass,
// never on a heartbeat. A press whose machine stopped partway leaves its row
// unfinished; it reads as stalled once the press lock is free (latestManualSync).
//
// Every write is best effort. A press that cannot record itself still syncs.

import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { heldSyncLocks } from '../sync-lock.js';
import type { VanSyncAnswer } from '../scheduler.js';
import { vanCampaigns, vanManualSyncRuns, vanSyncState, vanTurfs } from '../schema.js';
import { campaignName } from './campaigns.js';
import type { CampaignDrain } from './manual-geometry.js';

type Db = LibSQLDatabase<Record<string, unknown>>;

/** Runs kept: the page shows the latest; the rest are for reading back. */
const RUNS_KEPT = 10;

/** `waiting` for a scheduled sync to finish; `reading` VAN's catalog;
 *  drawing map `shapes`; `done`. */
export type ManualSyncPhase = 'waiting' | 'reading' | 'shapes' | 'done';

export interface CampaignPassReport {
	campaignId: number;
	name: string;
	/** `skipped`: another sync held the campaign's lock for the whole wait. */
	outcome: 'synced' | 'skipped' | 'failed';
	error?: string;
	/** Folders the catalog ran out of time for: their new turf waits for the
	 *  next sync. */
	foldersSkipped?: number;
	/** New routes not added because they replace turf held until the
	 *  campaign's midnight (changeHeld in catalog.ts). */
	newRoutesHeld?: number;
	/** No requested-turf folder is set, so no turf is read for requests. */
	noRequestedFolder: boolean;
}

export interface ManualSyncReport {
	/** As of the latest pass. */
	campaigns: CampaignPassReport[];
	/** The latest map-shape drain's, once one has run. */
	drain?: CampaignDrain[];
}

export interface ManualSyncRun {
	id: number;
	startedAt: string;
	startedByName: string | null;
	phase: ManualSyncPhase;
	passes: number;
	finishedAt: string | null;
	/** Unfinished, and nothing holds the press lock: its machine stopped. */
	stalled: boolean;
	report: ManualSyncReport | null;
	/** See van_manual_sync_runs.requested_turf_ids. */
	requestedTurfIds: number[] | null;
}

/**
 * One press's record, kept in step as it runs — through every pass, and
 * through a fresh run for presses past its last pass, so what it picked up is
 * counted from the press that started it.
 */
export class ManualSyncRecord {
	private report: ManualSyncReport = { campaigns: [] };
	private passes = 0;

	private constructor(
		private readonly db: Db,
		private readonly id: number | null,
	) {}

	/** Start a record. Never throws: without one, the press runs unrecorded. */
	static async start(
		db: Db,
		startedByName: string | null,
		phase: ManualSyncPhase,
	): Promise<ManualSyncRecord> {
		try {
			const startedAt = new Date().toISOString();
			// Before anything is read, so whatever lands after is the press's.
			let requestedTurfIds: string | null = null;
			try {
				requestedTurfIds = JSON.stringify(await requestedTurfNow(db));
			} catch (err) {
				console.error('[van] manual sync: could not read the requested turf:', errText(err));
			}
			const [row] = await db
				.insert(vanManualSyncRuns)
				.values({ startedAt, startedByName, phase, requestedTurfIds })
				.returning({ id: vanManualSyncRuns.id });
			await db.delete(vanManualSyncRuns).where(lt(vanManualSyncRuns.id, row!.id - RUNS_KEPT + 1));
			return new ManualSyncRecord(db, row!.id);
		} catch (err) {
			console.error('[van] manual sync: could not record the run:', errText(err));
			return new ManualSyncRecord(db, null);
		}
	}

	async phase(phase: 'waiting' | 'shapes'): Promise<void> {
		await this.write({ phase });
	}

	/** A pass reading VAN, counted across the press's runs. */
	async passStarted(): Promise<void> {
		this.passes++;
		await this.write({ phase: 'reading', passes: this.passes });
	}

	/** Running again, for a press that came in as it finished. */
	async reopen(phase: 'waiting' | 'reading'): Promise<void> {
		await this.write({ phase, finishedAt: null });
	}

	/** Each campaign's outcome on the pass just run. */
	async pass(answers: readonly VanSyncAnswer[]): Promise<void> {
		try {
			this.report.campaigns = await passReport(this.db, answers);
		} catch (err) {
			console.error('[van] manual sync: could not read the pass back:', errText(err));
			return;
		}
		await this.write({ report: JSON.stringify(this.report) });
	}

	async drain(drained: CampaignDrain[]): Promise<void> {
		this.report.drain = drained;
		await this.write({ report: JSON.stringify(this.report) });
	}

	async finish(): Promise<void> {
		await this.write({ phase: 'done', finishedAt: new Date().toISOString() });
	}

	private async write(patch: Partial<typeof vanManualSyncRuns.$inferInsert>): Promise<void> {
		if (this.id === null) return;
		try {
			await this.db.update(vanManualSyncRuns).set(patch).where(eq(vanManualSyncRuns.id, this.id));
		} catch (err) {
			console.error('[van] manual sync: could not update the run record:', errText(err));
		}
	}
}

/** Every enabled campaign's live requested turf, by id. */
async function requestedTurfNow(db: Db): Promise<number[]> {
	const rows = await db
		.select({ turfId: vanTurfs.turfId })
		.from(vanTurfs)
		.innerJoin(vanCampaigns, eq(vanCampaigns.id, vanTurfs.campaignId))
		.where(
			and(
				eq(vanCampaigns.enabled, true),
				eq(vanCampaigns.requestedFolderId, vanTurfs.folderId),
				isNull(vanTurfs.retiredAt),
			),
		);
	return rows.map((r) => r.turfId);
}

/**
 * Each enabled campaign's outcome, from the endpoint's answers. A failure's
 * reason is the endpoint's own where the answer carries it (failureReason),
 * else the one it wrote to van_sync_state.
 */
async function passReport(
	db: Db,
	answers: readonly VanSyncAnswer[],
): Promise<CampaignPassReport[]> {
	if (answers.length === 0) return [];
	const rows = await db
		.select({
			id: vanCampaigns.id,
			label: vanCampaigns.label,
			credentialKey: vanCampaigns.credentialKey,
			requestedFolderId: vanCampaigns.requestedFolderId,
			lastError: vanSyncState.lastError,
		})
		.from(vanCampaigns)
		.leftJoin(vanSyncState, eq(vanSyncState.campaignId, vanCampaigns.id))
		.where(
			inArray(
				vanCampaigns.id,
				answers.map((a) => a.campaignId),
			),
		);
	const byId = new Map(rows.map((r) => [r.id, r]));
	return answers.flatMap((answer) => {
		const campaign = byId.get(answer.campaignId);
		if (!campaign) return [];
		const report: CampaignPassReport = {
			campaignId: campaign.id,
			name: campaignName(campaign),
			outcome: 'synced',
			noRequestedFolder: campaign.requestedFolderId === null,
		};
		const body = answer.body ?? {};
		if (answer.error !== undefined || typeof body.error === 'string') {
			report.outcome = 'failed';
			report.error =
				typeof body.error === 'string'
					? body.error
					: failureReason(answer.error ?? '', campaign.lastError);
		} else if (typeof body.skipped === 'string') {
			report.outcome = 'skipped';
			report.error = body.skipped;
		}
		if (typeof body.foldersSkipped === 'number' && body.foldersSkipped > 0) {
			report.foldersSkipped = body.foldersSkipped;
		}
		if (typeof body.newTurfsHeld === 'number' && body.newTurfsHeld > 0) {
			report.newRoutesHeld = body.newTurfsHeld;
		}
		return [report];
	});
}

/** The latest press's record, or null before the first. */
export async function latestManualSync(db: Db, pressLock: string): Promise<ManualSyncRun | null> {
	const [row] = await db
		.select()
		.from(vanManualSyncRuns)
		.orderBy(desc(vanManualSyncRuns.id))
		.limit(1);
	if (!row) return null;
	const stalled = row.finishedAt === null && (await heldSyncLocks(db, [pressLock])).length === 0;
	let report: ManualSyncReport | null = null;
	try {
		report = row.report ? (JSON.parse(row.report) as ManualSyncReport) : null;
	} catch {
		// Shown without the detail.
	}
	let requestedTurfIds: number[] | null = null;
	try {
		requestedTurfIds = row.requestedTurfIds ? (JSON.parse(row.requestedTurfIds) as number[]) : null;
	} catch {
		// Falls back to when each turf was first seen (manual-sync-view.ts).
	}
	return {
		id: row.id,
		startedAt: row.startedAt,
		startedByName: row.startedByName,
		phase: row.phase as ManualSyncPhase,
		passes: row.passes,
		finishedAt: row.finishedAt,
		stalled,
		report,
		requestedTurfIds,
	};
}

/**
 * Why a campaign's call failed, in words for the page. A refused call's error
 * is `<path> answered <status>: <the response, cut at 300 characters>`. The
 * endpoint's answer is JSON, and a short one — a database error before any
 * campaign ran — parses, and says why. A long one is cut mid-JSON; the
 * campaign's own reason is then the one the endpoint wrote to van_sync_state.
 * Anything else — a timeout, a refused connection — is said as it is, less
 * the path.
 */
export function failureReason(error: string, lastError: string | null): string {
	const answered = /^\S+ answered (\d+): ([\s\S]*)$/.exec(error);
	if (!answered) return error.replace(/^\/\S+ /, 'the sync request ');
	try {
		const body = JSON.parse(answered[2]!) as {
			error?: unknown;
			campaigns?: Array<{ error?: unknown }>;
		};
		const reason = body.campaigns?.find((c) => typeof c.error === 'string')?.error ?? body.error;
		if (typeof reason === 'string') return reason;
	} catch {
		// Cut short: see above.
	}
	return lastError ?? `the sync request failed (HTTP ${answered[1]})`;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

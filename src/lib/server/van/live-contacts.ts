// The live ContactHistory poll behind the "I synced MiniVAN" check.
//
// Ticking that box should say at once whether VAN has the volunteer's doors.
// VAN cannot answer that per turf: the only read of contacts is the
// changed-entity export, an async job that takes 13-22s (measured 2026-10-13,
// scripts/van-contact-latency.ts). So the answer is kept ready instead. While
// anyone holds turf in a campaign, that campaign's last few minutes of
// ContactHistory are pulled every LIVE_POLL_MS into van_person_contacts, and
// the check (turfSyncCheck) is a read of our own tables.
//
// The same measurement found VAN itself quick: a contact synced at 04:01 was
// in an export started at 04:01:11. So the delay a volunteer sees is this
// poll's cadence plus one job — under a minute.
//
// Kept small so it costs little:
//   - Only while a claim is live, so nothing runs overnight with no turf out.
//   - A short window, from where this poll or the scheduled pull last read,
//     and never more than LIVE_MAX_LOOKBACK_MS back. Older contacts are the
//     scheduled pull's (contact-sync.ts), which also owns `cursor`, the counts
//     and every stamp; this writes contacts and `liveThrough` only.
//   - upsertContacts writes a row only when its date moves, so re-reading the
//     overlap costs reads, not writes.
//   - Contact types are cached, so a round is one job and its download.
//
// One machine polls a campaign at a time (vanLiveContactLock). The result is
// in the database, so a check on any machine sees it.

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { errMessage } from '../../err-message.js';
import {
	vanCampaigns,
	vanContactSyncState,
	vanPersonContacts,
	vanTurfCheckouts,
	vanTurfRoster,
	vanTurfs,
} from '../schema.js';
import { acquireSyncLock, releaseSyncLock } from '../sync-lock.js';
import { vanClientFor, vanPersonHasher } from '../van-env.js';
import type { VanClient } from './client.js';
import type { ContactCampaign } from './contact-live.js';
import {
	deletionChangeTypes,
	inPersonContactTypes,
	isStatus,
	KNOCK_LEAD_MS,
	readContactFile,
	upsertContacts,
} from './contact-sync.js';
import { responseChunks } from './hull-extract.js';
import { vanLiveContactLock } from './locks.js';
import type { PersonHasher } from './person-hash.js';

type Db = ReturnType<typeof drizzle>;
type FetchFn = typeof fetch;

const LOG = '[van]';
const MINUTE = 60 * 1000;

/** From the start of one round to the start of the next. */
export const LIVE_POLL_MS = 30 * 1000;
/** Each window reaches this far behind the last one. DateCreated is to the
 *  minute, and a contact can surface a little after its DateChanged. */
export const LIVE_OVERLAP_MS = 3 * MINUTE;
/** The furthest back a window starts. Anything older is the scheduled pull's
 *  to read, every 30 minutes. */
export const LIVE_MAX_LOOKBACK_MS = 60 * MINUTE;
/** How long a round waits on VAN's job before leaving it. The next round asks
 *  for a fresh window rather than resuming it. */
const JOB_BUDGET_MS = 60 * 1000;
const JOB_POLL_MS = 2000;
/** Past any round's own budget, so a crashed poller frees it within minutes. */
const LOCK_TTL_MS = 2 * MINUTE;
/** Contact and change types barely ever change; asking each round would be
 *  two more VAN calls every half minute. */
const TYPES_TTL_MS = 60 * MINUTE;

const typesCache = new Map<number, { at: number; inPerson: Set<string>; deletions: Set<string> }>();

async function contactKinds(
	client: VanClient,
	campaignId: number,
	now: number,
): Promise<{ inPerson: Set<string>; deletions: Set<string> }> {
	const cached = typesCache.get(campaignId);
	if (cached && now - cached.at < TYPES_TTL_MS) return cached;
	const kinds = {
		at: now,
		inPerson: await inPersonContactTypes(client),
		deletions: await deletionChangeTypes(client),
	};
	typesCache.set(campaignId, kinds);
	return kinds;
}

/** For tests. */
export function clearContactKindsCache(): void {
	typesCache.clear();
}

/** Enabled campaigns with at least one live claim: the ones worth polling. */
export async function campaignsWithLiveClaims(db: Db, now: Date): Promise<ContactCampaign[]> {
	return db
		.selectDistinct({ id: vanCampaigns.id, credentialKey: vanCampaigns.credentialKey })
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanTurfCheckouts.turfId))
		.innerJoin(vanCampaigns, eq(vanCampaigns.id, vanTurfs.campaignId))
		.where(
			and(
				eq(vanCampaigns.enabled, true),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
				gt(vanTurfCheckouts.expiresAt, now.toISOString()),
			),
		);
}

export interface LivePollOptions {
	campaignId: number;
	hasher: PersonHasher;
	now?: Date;
	budgetMs?: number;
	fetchFn?: FetchFn;
	sleep?: (ms: number) => Promise<void>;
}

export type LivePollResult =
	/** `contacts` read from VAN; `written` of them new or later than stored. */
	| { kind: 'read'; from: string; through: string; contacts: number; written: number }
	/** VAN had not finished the job inside the budget. */
	| { kind: 'pending' };

/** The later of two ISO stamps, either of which may be missing. */
function later(a: string | null, b: string | null): string | null {
	if (a === null) return b;
	if (b === null) return a;
	return a > b ? a : b;
}

/**
 * One round for one campaign: read ContactHistory from just behind where it
 * was last read up to now, store the in-person contacts, and move
 * `liveThrough`. Throws on a VAN failure; the caller logs it and the next
 * round tries again.
 */
export async function pollLiveContacts(
	db: Db,
	client: VanClient,
	options: LivePollOptions,
): Promise<LivePollResult> {
	const { campaignId, hasher } = options;
	const now = options.now ?? new Date();
	const fetchFn = options.fetchFn ?? fetch;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const deadline = Date.now() + (options.budgetMs ?? JOB_BUDGET_MS);

	const [state] = await db
		.select({ cursor: vanContactSyncState.cursor, liveThrough: vanContactSyncState.liveThrough })
		.from(vanContactSyncState)
		.where(eq(vanContactSyncState.campaignId, campaignId));
	const readTo = later(state?.liveThrough ?? null, state?.cursor ?? null);
	const floorMs = now.getTime() - LIVE_MAX_LOOKBACK_MS;
	const fromMs = Math.max(readTo ? Date.parse(readTo) - LIVE_OVERLAP_MS : floorMs, floorMs);
	const from = new Date(fromMs).toISOString();
	const through = now.toISOString();

	const kinds = await contactKinds(client, campaignId, now.getTime());
	const created = await client.createChangedEntityExportJob({
		resourceType: 'ContactHistory',
		dateChangedFrom: from,
		dateChangedTo: through,
	});
	let job = await client.changedEntityExportJob(created.exportJobId);
	while (!isStatus(job, 'complete') && !isStatus(job, 'error')) {
		if (deadline - Date.now() < JOB_POLL_MS) return { kind: 'pending' };
		await sleep(JOB_POLL_MS);
		job = await client.changedEntityExportJob(created.exportJobId);
	}
	if (isStatus(job, 'error')) {
		throw new Error(
			`ContactHistory export ${job.exportJobId} failed: ${job.message ?? 'no message'}`,
		);
	}

	const contacts = new Map<string, { personHash: Buffer; at: string }>();
	for (const file of job.files ?? []) {
		const res = await fetchFn(file.downloadUrl, {
			signal: AbortSignal.timeout(Math.max(5_000, deadline - Date.now())),
		});
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			throw new Error(
				`ContactHistory export ${job.exportJobId}: download returned HTTP ${res.status}`,
			);
		}
		await readContactFile(responseChunks(res), kinds, hasher, contacts);
	}
	const written = await upsertContacts(db, campaignId, contacts);
	await db
		.insert(vanContactSyncState)
		.values({ campaignId, liveThrough: through })
		.onConflictDoUpdate({
			target: vanContactSyncState.campaignId,
			set: { liveThrough: through },
		});
	return { kind: 'read', from, through, contacts: contacts.size, written };
}

/** One round across every campaign with turf out. */
export async function liveContactRound(db: Db): Promise<void> {
	// No hasher, no rosters to check against: the feature is off.
	const hasher = vanPersonHasher();
	if (!hasher) return;
	for (const campaign of await campaignsWithLiveClaims(db, new Date())) {
		const configured = vanClientFor(campaign);
		if (!configured.ok) continue;
		const lock = vanLiveContactLock(campaign.id);
		const token = await acquireSyncLock(db, lock, LOCK_TTL_MS);
		if (!token) continue;
		try {
			const result = await pollLiveContacts(db, configured.client, {
				campaignId: campaign.id,
				hasher,
			});
			// Quiet when nothing came in, or this would log every half minute.
			// Only rounds that wrote something: each window re-reads the last few
			// minutes, so the same contacts come back for several rounds running.
			if (result.kind === 'read' && result.written > 0) {
				console.log(`${LOG} live contacts for campaign ${campaign.id}: ${result.written} new`);
			} else if (result.kind === 'pending') {
				console.warn(`${LOG} live contacts for campaign ${campaign.id}: VAN's job ran long`);
			}
		} catch (err) {
			console.warn(`${LOG} live contacts for campaign ${campaign.id}:`, errMessage(err));
		} finally {
			await releaseSyncLock(db, lock, token).catch(() => {});
		}
	}
}

/** Start polling. Each round starts LIVE_POLL_MS after the last one started,
 *  or straight after it when VAN ran longer. Returns a function that stops it. */
export function startLiveContactPoll(db: Db): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout>;
	const schedule = (ms: number) => {
		timer = setTimeout(() => void round(), ms);
		timer.unref();
	};
	const round = async () => {
		const started = Date.now();
		try {
			await liveContactRound(db);
		} catch (err) {
			console.error(`${LOG} live contacts round failed:`, errMessage(err));
		}
		if (!stopped) schedule(Math.max(1000, started + LIVE_POLL_MS - Date.now()));
	};
	schedule(LIVE_POLL_MS);
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}

export interface TurfSyncCheck {
	/** Doors on the turf with an in-person contact since the claim. Null when
	 *  the turf has no roster to count against. */
	doors: number | null;
	totalDoors: number | null;
	/** How recently VAN was read, by this poll or the scheduled pull. */
	checkedThrough: string | null;
	/** How long before `now` that was, on the server's clock, so the page
	 *  never sets the server's stamp against the browser's clock. */
	checkedAgeMs: number | null;
}

/**
 * What the "I synced MiniVAN" box shows: how many of the turf's doors VAN has
 * an in-person contact for since this volunteer claimed it. Null when they do
 * not hold it.
 *
 * Counted the way doors knocked is (stampDoorsKnocked), from KNOCK_LEAD_MS
 * before the claim, but up to now: the claim is still live. Display only —
 * nothing is stamped, so the rule that only a scheduled run stamps
 * `doorsKnocked` holds.
 */
export async function turfSyncCheck(
	db: Db,
	input: { turfId: number; slackUserId: string; now: Date },
): Promise<TurfSyncCheck | null> {
	const [claim] = await db
		.select({ claimedAt: vanTurfCheckouts.claimedAt, campaignId: vanTurfs.campaignId })
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanTurfCheckouts.turfId))
		.where(
			and(
				eq(vanTurfCheckouts.turfId, input.turfId),
				eq(vanTurfCheckouts.slackUserId, input.slackUserId),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
				gt(vanTurfCheckouts.expiresAt, input.now.toISOString()),
			),
		);
	if (!claim) return null;

	const since = new Date(Date.parse(claim.claimedAt) - KNOCK_LEAD_MS).toISOString();
	const [count] = await db
		.select({
			total: sql<number>`count(DISTINCT ${vanTurfRoster.doorHash})`,
			knocked: sql<number>`count(DISTINCT CASE WHEN ${vanPersonContacts.lastInPersonAt} >= ${since}
				THEN ${vanTurfRoster.doorHash} END)`,
		})
		.from(vanTurfRoster)
		.leftJoin(
			vanPersonContacts,
			and(
				eq(vanPersonContacts.campaignId, claim.campaignId),
				eq(vanPersonContacts.personHash, vanTurfRoster.personHash),
			),
		)
		.where(eq(vanTurfRoster.turfId, input.turfId));
	const [state] = await db
		.select({ cursor: vanContactSyncState.cursor, liveThrough: vanContactSyncState.liveThrough })
		.from(vanContactSyncState)
		.where(eq(vanContactSyncState.campaignId, claim.campaignId));

	const total = Number(count?.total ?? 0);
	const checkedThrough = later(state?.liveThrough ?? null, state?.cursor ?? null);
	return {
		doors: total > 0 ? Number(count!.knocked) : null,
		totalDoors: total > 0 ? total : null,
		checkedThrough,
		checkedAgeMs:
			checkedThrough === null
				? null
				: Math.max(0, input.now.getTime() - Date.parse(checkedThrough)),
	};
}

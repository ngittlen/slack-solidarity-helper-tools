// What the settings pages show about each VAN campaign: how its syncs are
// going and how much turf and how many claims it has. Read-only, from the
// tables the sync already keeps — nothing here calls VAN.
//
// Credentials are not read here; van-env.ts `credentialStatus` says what may be
// said about those.

import { and, count, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import {
	vanCampaigns,
	vanChapterFolders,
	vanContactSyncState,
	vanGeometryQueue,
	vanSyncState,
	vanTurfCheckouts,
	vanTurfs,
	type VanCampaignRow,
} from '../schema.js';

type Db = ReturnType<typeof drizzle>;

/** One row of the /settings campaign list. */
export interface CampaignSummary {
	campaign: VanCampaignRow;
	liveTurfs: number;
	lastSyncAt: string | null;
	lastError: string | null;
}

/** Every campaign, oldest first, with what the list shows about it. */
export async function loadCampaignSummaries(db: Db): Promise<CampaignSummary[]> {
	const campaigns = await db.select().from(vanCampaigns).orderBy(vanCampaigns.id);
	if (campaigns.length === 0) return [];
	const [turfCounts, states] = await Promise.all([
		db
			.select({ campaignId: vanTurfs.campaignId, n: count() })
			.from(vanTurfs)
			.where(isNull(vanTurfs.retiredAt))
			.groupBy(vanTurfs.campaignId),
		db.select().from(vanSyncState),
	]);
	const turfsBy = new Map(turfCounts.map((r) => [r.campaignId, Number(r.n)]));
	const stateBy = new Map(states.map((r) => [r.campaignId, r]));
	return campaigns.map((campaign) => ({
		campaign,
		liveTurfs: turfsBy.get(campaign.id) ?? 0,
		lastSyncAt: stateBy.get(campaign.id)?.lastSyncAt ?? null,
		lastError: stateBy.get(campaign.id)?.lastError ?? null,
	}));
}

/** Everything the campaign page's status section shows. */
export interface CampaignStatus {
	lastSyncAt: string | null;
	lastError: string | null;
	/** Null before the first completed sync. */
	minivanExportsOk: boolean | null;
	liveTurfs: number;
	retiredTurfs: number;
	/** Live turf nobody holds — what a disable hides. */
	unclaimedLiveTurfs: number;
	/** Claims still running — what a disable lets finish. */
	liveClaims: number;
	geometryPending: number;
	geometryFailed: number;
	contactCursor: string | null;
	contactLastError: string | null;
	/** Chapter → folder rows for this campaign. Enabling needs at least one. */
	mappedFolders: number;
}

export async function loadCampaignStatus(
	db: Db,
	campaignId: number,
	now: Date,
): Promise<CampaignStatus> {
	const nowIso = now.toISOString();
	// A claim past its expiry is over even before the sweep stamps it, the
	// same rule the turf page applies.
	const live = and(
		isNull(vanTurfCheckouts.releasedAt),
		isNull(vanTurfCheckouts.completedAt),
		gt(vanTurfCheckouts.expiresAt, nowIso),
	);
	const [[sync], turfCounts, [claims], [held], queue, [contacts], [folders]] = await Promise.all([
		db.select().from(vanSyncState).where(eq(vanSyncState.campaignId, campaignId)),
		db
			.select({ retired: sql<number>`${vanTurfs.retiredAt} is not null`, n: count() })
			.from(vanTurfs)
			.where(eq(vanTurfs.campaignId, campaignId))
			.groupBy(sql`${vanTurfs.retiredAt} is not null`),
		db
			.select({ n: count() })
			.from(vanTurfCheckouts)
			.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanTurfCheckouts.turfId))
			.where(and(eq(vanTurfs.campaignId, campaignId), live)),
		db
			.select({ n: sql<number>`count(distinct ${vanTurfCheckouts.turfId})` })
			.from(vanTurfCheckouts)
			.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanTurfCheckouts.turfId))
			.where(and(eq(vanTurfs.campaignId, campaignId), isNull(vanTurfs.retiredAt), live)),
		db
			.select({ status: vanGeometryQueue.status, n: count() })
			.from(vanGeometryQueue)
			.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanGeometryQueue.turfId))
			.where(
				and(
					eq(vanTurfs.campaignId, campaignId),
					inArray(vanGeometryQueue.status, ['pending', 'running', 'failed']),
				),
			)
			.groupBy(vanGeometryQueue.status),
		db.select().from(vanContactSyncState).where(eq(vanContactSyncState.campaignId, campaignId)),
		db
			.select({ n: count() })
			.from(vanChapterFolders)
			.where(
				and(eq(vanChapterFolders.campaignId, campaignId), isNotNull(vanChapterFolders.folderId)),
			),
	]);

	const liveTurfs = Number(turfCounts.find((r) => !Number(r.retired))?.n ?? 0);
	const queued = (status: string) => Number(queue.find((r) => r.status === status)?.n ?? 0);
	return {
		lastSyncAt: sync?.lastSyncAt ?? null,
		lastError: sync?.lastError ?? null,
		minivanExportsOk: sync?.minivanExportsOk ?? null,
		liveTurfs,
		retiredTurfs: Number(turfCounts.find((r) => Number(r.retired))?.n ?? 0),
		unclaimedLiveTurfs: Math.max(0, liveTurfs - Number(held?.n ?? 0)),
		liveClaims: Number(claims?.n ?? 0),
		geometryPending: queued('pending') + queued('running'),
		geometryFailed: queued('failed'),
		contactCursor: contacts?.cursor ?? null,
		contactLastError: contacts?.lastError ?? null,
		mappedFolders: Number(folders?.n ?? 0),
	};
}

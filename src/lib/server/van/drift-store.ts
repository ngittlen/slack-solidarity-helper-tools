// The rows the drift report compares, and whether the comparison is legible.
//
// Both sides come from our own database: `van_turfs.van_distributed_to` (which
// the catalog sync writes, Story 8.1) and the checkout ledger. No VAN call —
// which matters, because this runs on a page load and the sync's cadence is
// already the right place to talk to VAN.
//
// Unlike the holdings board, this reads turf that nobody has claimed as well as
// turf that somebody has: half the drift is turf VAN says is out and our ledger
// says is free, and that row has no checkout to find it by.

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanCampaigns, vanSyncState, vanTurfCheckouts, vanTurfs } from '../schema.js';
import type { DriftClaim, DriftTurfRow, DriftVisibility } from '../../van/turf-drift.js';
import { visibleToChapter } from './chapter-visibility.js';

type Db = ReturnType<typeof drizzle>;

export interface DriftQuery {
	/** Null means every chapter. */
	chapterId: number | null;
}

function chapterFilter(chapterId: number | null): SQL | undefined {
	// The chapter's FOLDERS, not the label on the row: a folder mapped to
	// several chapters is visible to all of them (chapter-visibility.ts).
	return visibleToChapter(chapterId);
}

/**
 * Turf whose campaign is enabled and whose last catalog sync could read its
 * MiniVAN exports.
 *
 * Drift is judged campaign by campaign: each reads its own committee's exports
 * with its own key, so one campaign whose key lacks /minivanExports (or is
 * still backfilling) must not make another campaign's turf look undistributed —
 * nor be reported itself, since for it "not in MiniVAN" means "we could not
 * ask". Its turf is left out of the comparison entirely, stamps included, so a
 * drift already announced for it is neither repeated nor cleared.
 */
export function exportsVisibleFilter(): SQL {
	return sql`${vanTurfs.campaignId} in (${exportsVisibleCampaigns()})`;
}

/**
 * Campaigns whose MiniVAN exports the app can still see. A disabled campaign
 * is not synced, so its last sync's "exports ok" goes stale the moment it is
 * switched off: a list loaded since then never reaches `van_distributed_to`,
 * and its claims would read as "not loaded in MiniVAN" until they end. It is
 * left out like a campaign whose key cannot read exports at all.
 */
function exportsVisibleCampaigns(): SQL {
	return sql`select ${vanSyncState.campaignId} from ${vanSyncState}
		join ${vanCampaigns} on ${vanCampaigns.id} = ${vanSyncState.campaignId}
		where ${vanSyncState.minivanExportsOk} = 1 and ${vanCampaigns.enabled} = 1`;
}

/** Every turf in scope, claimed or not. Retired rows come back and the pure
 *  rule drops them, so the "skip retired" decision stays in one place next to
 *  the reasoning for it. */
export async function loadDriftTurfs(db: Db, query: DriftQuery): Promise<DriftTurfRow[]> {
	return db
		.select({
			turfId: vanTurfs.turfId,
			name: vanTurfs.name,
			regionName: vanTurfs.regionName,
			chapterId: vanTurfs.chapterId,
			chapterName: vanTurfs.chapterName,
			doorCount: vanTurfs.doorCount,
			printedListNumber: vanTurfs.printedListNumber,
			vanDistributedTo: vanTurfs.vanDistributedTo,
			retiredAt: vanTurfs.retiredAt,
		})
		.from(vanTurfs)
		.where(and(chapterFilter(query.chapterId), exportsVisibleFilter()));
}

/**
 * Claims the ledger has not closed, across the turf in scope.
 *
 * Scoped by the join rather than by turf id list: the caller wants "claims on
 * this chapter's turf", and passing several hundred route ids into an `IN` to
 * express that would be the same query written worse.
 */
export async function loadDriftClaims(db: Db, query: DriftQuery): Promise<DriftClaim[]> {
	return db
		.select({
			turfId: vanTurfCheckouts.turfId,
			slackUserId: vanTurfCheckouts.slackUserId,
			slackUserName: vanTurfCheckouts.slackUserName,
			claimedAt: vanTurfCheckouts.claimedAt,
			expiresAt: vanTurfCheckouts.expiresAt,
			releasedAt: vanTurfCheckouts.releasedAt,
			completedAt: vanTurfCheckouts.completedAt,
			loadedInMinivanAt: vanTurfCheckouts.loadedInMinivanAt,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.turfId, vanTurfs.turfId))
		.where(
			and(
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
				chapterFilter(query.chapterId),
				exportsVisibleFilter(),
			),
		);
}

/**
 * Whether any enabled campaign's last catalog sync could read
 * `/minivanExports`. The turf and claims above already leave out the campaigns
 * that could not, and the disabled ones.
 *
 * Without this the report cannot tell "VAN reports nothing distributed" from
 * "we never got to ask", because the sync writes NULL into
 * `van_distributed_to` in both cases.
 *
 * An absent row — no sync has ever completed — reads as unavailable rather than
 * visible. Before the first sync there is genuinely nothing to compare against,
 * and an empty report at that point would be reassurance drawn from an empty
 * table.
 */
export async function loadDriftVisibility(db: Db): Promise<DriftVisibility> {
	const [row] = await db
		.select({ minivanExportsOk: vanSyncState.minivanExportsOk })
		.from(vanSyncState)
		.innerJoin(vanCampaigns, eq(vanCampaigns.id, vanSyncState.campaignId))
		.where(and(eq(vanSyncState.minivanExportsOk, true), eq(vanCampaigns.enabled, true)))
		.limit(1);
	return row?.minivanExportsOk === true ? 'visible' : 'van-side-unavailable';
}

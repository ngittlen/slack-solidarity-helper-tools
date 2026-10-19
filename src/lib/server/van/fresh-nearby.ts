// Which turf knocked before its cut waits for fresh turf nearby.
//
// A campaign that re-cuts walked turf without leaving out the knocked doors
// lists them all as untouched, and MiniVAN sends the next volunteer back to
// them. The map stripes that turf (`hasContactHistory`) and the list sinks it;
// this is what keeps it from being claimed while turf nobody has been to is
// free within FRESH_TURF_RADIUS_MILES. See `TurfSnapshot.freshTurfNearby`.
//
// Decided on read, never stored: whether a neighbour is free changes with every
// claim and release, so a stored flag would be stale within minutes. The cost
// is one box read on the centroid columns, the same as the signed-out teaser's
// (nearby-summary.ts), and nothing at all when no striped turf is asked about.
//
// "Free" is `canClaim` with no viewer and no cap — could ANYONE take it — so a
// neighbourhood whose fresh turf is all out releases its striped turf, and
// comes back to holding it when a claim on the fresh turf ends. The pool is
// not limited by chapter, like the teaser's: the claim route has no chapter to
// scope by, and turf two miles away is nearly always in the same one.
//
// The one exception is the volunteer who checked the turf out last. They are
// the one who knows which of its doors they reached, so they may take it back
// to finish it whatever is free nearby. Anyone has claimed it since, and it is
// held back from them like from anyone else. "The turf" is the ground, not the
// cut: a region refresh retires every route in it and issues new ones under the
// same names (turf-history-store.ts), and the re-cut is exactly what stripes
// the turf, so their last checkout is nearly always on an earlier cut.

import { and, between, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfCheckouts, vanTurfs, type VanTurfRow } from '../schema.js';
import { turfCampaignEnabled } from './campaigns.js';
import { latestWalkReports } from './checkout-store.js';
import { chunked } from './sql-chunk.js';
import {
	canClaim,
	FRESH_TURF_RADIUS_MILES,
	type ClaimOptions,
	type ClaimSnapshot,
} from '../../van/checkout.js';
import { haversineMeters, type LatLng } from '../../van/geometry.js';
import { METRES_PER_MILE } from '../../van/nearby-summary.js';
import { claimDoorsLeft, hasContactHistory, turfSnapshot } from '../../van/turf-view.js';

type Db = ReturnType<typeof drizzle>;

/** No viewer: the question is whether anyone could take the fresh turf. */
const ANYONE = '';
const NO_CAP = { maxConcurrentClaims: Number.MAX_SAFE_INTEGER };

const RADIUS_METRES = FRESH_TURF_RADIUS_MILES * METRES_PER_MILE;

function centreOf(row: Pick<VanTurfRow, 'centroidLat' | 'centroidLng'>): LatLng | null {
	return row.centroidLat === null || row.centroidLng === null
		? null
		: { lat: row.centroidLat, lng: row.centroidLng };
}

/**
 * The routes among `rows` that are knocked before their cut and have free,
 * fresh turf within FRESH_TURF_RADIUS_MILES — what `turfSnapshot` takes as
 * `freshTurfNearby`, for `viewerSlackUserId`. A turf with no centroid is never
 * held back: there is no telling what is near it. Nor is one whose latest
 * checkout, on this cut or an earlier one, was the viewer's, so they can come
 * back and finish it.
 */
export async function gatedByFreshTurf(
	db: Db,
	rows: readonly VanTurfRow[],
	viewerSlackUserId: string,
	now: Date,
	claimOptions: ClaimOptions = {},
): Promise<Set<number>> {
	const striped = rows.flatMap((row) => {
		const centre = hasContactHistory(row) ? centreOf(row) : null;
		return centre ? [{ turfId: row.turfId, centre }] : [];
	});
	const gated = new Set<number>();
	if (striped.length === 0) return gated;

	// One box around every striped turf, widened by the radius.
	const lats = striped.map((s) => s.centre.lat);
	const lngs = striped.map((s) => s.centre.lng);
	const minLat = Math.min(...lats);
	const maxLat = Math.max(...lats);
	const dLat = FRESH_TURF_RADIUS_MILES / 69.05;
	const widestLat = Math.max(Math.abs(minLat), Math.abs(maxLat));
	const dLng =
		FRESH_TURF_RADIUS_MILES / (69.17 * Math.max(0.05, Math.cos((widestLat * Math.PI) / 180)));

	const nearby = await db
		.select()
		.from(vanTurfs)
		.where(
			and(
				isNull(vanTurfs.retiredAt),
				isNull(vanTurfs.hiddenAt),
				turfCampaignEnabled(),
				isNotNull(vanTurfs.centroidLat),
				isNotNull(vanTurfs.centroidLng),
				between(vanTurfs.centroidLat, minLat - dLat, maxLat + dLat),
				between(vanTurfs.centroidLng, Math.min(...lngs) - dLng, Math.max(...lngs) + dLng),
			),
		);

	// The checks that need no other table first, so claims and walk reports
	// are read only for turf that could still count.
	const fresh = nearby.flatMap((row) => {
		if (hasContactHistory(row) || !row.printedListNumber || claimDoorsLeft(row) <= 0) return [];
		const centre = centreOf(row)!;
		const near = striped.filter((s) => haversineMeters(s.centre, centre) <= RADIUS_METRES);
		return near.length > 0 ? [{ row, near }] : [];
	});
	if (fresh.length === 0) return gated;

	const ids = fresh.map((f) => f.row.turfId);
	const claims = await activeClaimsOn(db, ids);
	const walkReports = await latestWalkReports(db, ids);
	for (const { row, near } of fresh) {
		if (near.every((s) => gated.has(s.turfId))) continue;
		const snapshot = turfSnapshot(row, now, {
			walkReports,
			vanAssignmentTtlHours: claimOptions.vanAssignmentTtlHours,
		});
		if (canClaim(snapshot, claims, ANYONE, now, NO_CAP).ok) {
			for (const s of near) gated.add(s.turfId);
		}
	}

	// Last, so the ledger is read only for turf that would otherwise wait.
	if (gated.size > 0) {
		const held = rows.filter((row) => gated.has(row.turfId));
		for (const turfId of await lastCheckedOutBy(db, held, viewerSlackUserId)) {
			gated.delete(turfId);
		}
	}
	return gated;
}

/** Which cuts are the same ground: VAN keeps the region and the name across a
 *  refresh. Region as well as name, because names like "Turf 3" repeat. */
function groundOf(row: Pick<VanTurfRow, 'campaignId' | 'mapRegionId' | 'name'>): string {
	return `${row.campaignId}:${row.mapRegionId}:${row.name}`;
}

/** The routes among `turfs` whose most recent checkout, live or ended, on any
 *  cut of the same ground, was `slackUserId`'s. */
async function lastCheckedOutBy(
	db: Db,
	turfs: readonly VanTurfRow[],
	slackUserId: string,
): Promise<number[]> {
	const grounds = new Set(turfs.map(groundOf));
	const lastBy = new Map<string, string>();
	for (const batch of chunked([...new Set(turfs.map((t) => t.name))])) {
		const rows = await db
			.select({
				campaignId: vanTurfs.campaignId,
				mapRegionId: vanTurfs.mapRegionId,
				name: vanTurfs.name,
				slackUserId: vanTurfCheckouts.slackUserId,
			})
			.from(vanTurfCheckouts)
			.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanTurfCheckouts.turfId))
			.where(inArray(vanTurfs.name, batch))
			.orderBy(desc(vanTurfCheckouts.claimedAt), desc(vanTurfCheckouts.id));
		for (const row of rows) {
			// Newest first, so the first row per ground is the last checkout.
			const ground = groundOf(row);
			if (grounds.has(ground) && !lastBy.has(ground)) lastBy.set(ground, row.slackUserId);
		}
	}
	return turfs.filter((t) => lastBy.get(groundOf(t)) === slackUserId).map((t) => t.turfId);
}

/** Open claims on these routes. `canClaim` reads expiry itself. */
async function activeClaimsOn(db: Db, turfIds: number[]): Promise<ClaimSnapshot[]> {
	const claims: ClaimSnapshot[] = [];
	for (const batch of chunked(turfIds)) {
		const rows = await db
			.select()
			.from(vanTurfCheckouts)
			.where(
				and(
					inArray(vanTurfCheckouts.turfId, batch),
					isNull(vanTurfCheckouts.releasedAt),
					isNull(vanTurfCheckouts.completedAt),
				),
			);
		claims.push(
			...rows.map((c) => ({
				turfId: c.turfId,
				slackUserId: c.slackUserId,
				slackUserName: c.slackUserName,
				claimedAt: c.claimedAt,
				expiresAt: c.expiresAt,
				releasedAt: c.releasedAt,
				completedAt: c.completedAt,
			})),
		);
	}
	return claims;
}

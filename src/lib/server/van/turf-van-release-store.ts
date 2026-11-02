// Releasing turf from an outside VAN hand-out: one turf from its card on
// /turfs, or every such turf at once from /turfs/organizer.
//
// For turf VAN still reads as handed out — its list loaded in MiniVAN outside
// any claim here — that an organizer knows is free: the canvasser gave it
// back, or the hand-out time limit cannot apply because the turf has no
// current door count. What a release means is enforced elsewhere: the catalog
// sync ignores exports at or before `vanReleasedAt` (outsideAssignment in
// catalog.ts), does not write such a hand-out back (unlessReleased in
// sync.ts), and vanAssignmentBlocks does not count one.
//
// `vanReleasedAt` is the time of the hand-out released, not of the click. A
// MiniVAN load between the two is someone else picking the list up, and must
// still hold the turf once the sync reads it; a cutoff at the click would
// erase it for good. A hand-out with no date is released as of when the
// caller saw it — the card built, or the summary counted — for the same
// reason.
//
// A release names the hand-out it means, and a turf VAN has handed out again
// since is left held (sameHandOut).
//
// Only turf the card offers the release on is released: heldOnlyInVan in
// turf-view.ts, the rule the card's button is shown by. A Packet Tracker entry
// is the campaign's own record and is left alone; the turf stays out of the
// pool while the sheet lists someone on it.

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanCampaigns, vanTurfCheckouts, vanTurfs } from '../schema.js';
import { heldOnlyInVan } from '../../van/turf-view.js';
import type { VanReleaseOutcome, VanSkipReason } from '../../van/van-release-result.js';
import { idRows } from './sql-chunk.js';
import { turfCampaignEnabled } from './campaigns.js';

type Db = ReturnType<typeof drizzle>;

/** Why a release did not happen, when it did not. `changed`: VAN handed the
 *  turf out again after the caller saw it. `claimed`: a claim here holds it.
 *  `sheet`: the Packet Tracker lists someone on it. `not-held`: nothing VAN
 *  gave out holds it any more — released already, retired, or past the time
 *  limit. */
export type VanReleaseResult = 'released' | VanSkipReason;

/** A live claim on the turf, as activeClaimFor counts one: not ended and not
 *  lapsed. The expiry is compared as a time, not as text, as isActive parses
 *  it: an ISO time without milliseconds sorts after one with them as text, and
 *  an expiry that does not parse is no claim (julianday is null). */
function liveClaim(now: Date) {
	return sql`exists (select 1 from ${vanTurfCheckouts} where ${vanTurfCheckouts.turfId} = ${vanTurfs.turfId} and ${vanTurfCheckouts.releasedAt} is null and ${vanTurfCheckouts.completedAt} is null and julianday(${vanTurfCheckouts.expiresAt}) > julianday(${now.toISOString()}))`;
}

/**
 * heldOnlyInVan less the time limit, which is read in code: the narrowing
 * every read starts from, and what each release's own update checks again, so
 * a claim or sheet entry landing between the read and the write keeps its
 * turf held. Blank text counts as no value, as heldOnlyInVan reads it.
 */
function heldOnlyInVanWhere(now: Date) {
	return and(
		isNotNull(vanTurfs.vanDistributedTo),
		sql`${vanTurfs.vanDistributedTo} <> ''`,
		sql`coalesce(${vanTurfs.sheetAssignedTo}, '') = ''`,
		sql`coalesce(${vanTurfs.retiredAt}, '') = ''`,
		sql`not ${liveClaim(now)}`,
	);
}

/** What the bulk release may reach, beyond what a card releases: turf
 *  outside the campaign's requested-turf folder, whose turf an organizer cut
 *  for a particular request and still releases from its own card; and only
 *  in a campaign that is switched on, as /turfs draws no other's turf, so no
 *  organizer has seen it to judge it free. */
function inBulkRelease() {
	return and(
		sql`not exists (select 1 from ${vanCampaigns} where ${vanCampaigns.id} = ${vanTurfs.campaignId} and ${vanCampaigns.requestedFolderId} = ${vanTurfs.folderId})`,
		turfCampaignEnabled(),
	);
}

/** When the caller saw the turf, never later than now: a time in the future
 *  would ignore MiniVAN loads not made yet. */
function seenBy(seenAt: Date, now: Date): string {
	return (seenAt < now ? seenAt : now).toISOString();
}

/** The stamp: the released hand-out's own time, or when the caller saw a
 *  hand-out with no date. A blank date is no date, as everywhere a release is
 *  read: a blank stamp would read as never released. */
function releaseStamp(seenAt: string, editor: { name: string }) {
	return {
		vanDistributedTo: null,
		vanAssignedAt: null,
		vanReleasedAt: sql`coalesce(nullif(${vanTurfs.vanAssignedAt}, ''), ${seenAt})`,
		vanReleasedBy: editor.name,
	};
}

/** A held turf as the release reads it: where it is, for the bulk summary,
 *  and the hand-out time the caller must have seen. */
export interface VanHeldTurf {
	turfId: number;
	campaignId: number;
	folderId: number;
	chapterName: string;
	since: string | null;
}

/** What the caller saw on its card or in its summary: the turf, and the time
 *  of the hand-out it means to release. */
export interface SeenHandOut {
	turfId: number;
	since: string | null;
}

const heldColumns = {
	turfId: vanTurfs.turfId,
	campaignId: vanTurfs.campaignId,
	folderId: vanTurfs.folderId,
	chapterName: vanTurfs.chapterName,
	vanDistributedTo: vanTurfs.vanDistributedTo,
	vanAssignedAt: vanTurfs.vanAssignedAt,
	vanReleasedAt: vanTurfs.vanReleasedAt,
	sheetAssignedTo: vanTurfs.sheetAssignedTo,
	retiredAt: vanTurfs.retiredAt,
	doorCount: vanTurfs.doorCount,
	uncontactedDoors: vanTurfs.uncontactedDoors,
	knockedBeforeCut: vanTurfs.knockedBeforeCut,
	savedListId: vanTurfs.savedListId,
	rosterSavedListId: vanTurfs.rosterSavedListId,
};

/** Turf matching `where` that heldOnlyInVan holds, under no claim here. */
async function stillHeld(
	db: Db,
	where: ReturnType<typeof and>,
	now: Date,
	vanAssignmentTtlHours: number,
): Promise<VanHeldTurf[]> {
	const rows = await db
		.select(heldColumns)
		.from(vanTurfs)
		.where(and(heldOnlyInVanWhere(now), where));
	return rows
		.filter((row) => heldOnlyInVan(row, false, now, vanAssignmentTtlHours))
		.map((row) => ({
			turfId: row.turfId,
			campaignId: row.campaignId,
			folderId: row.folderId,
			chapterName: row.chapterName,
			since: row.vanAssignedAt,
		}));
}

/** The turf's hand-out is still the one the caller saw. A MiniVAN load the
 *  sync read after the card or summary loaded is someone else's, and is not
 *  the caller's to release. Checked in the update itself, so a sync landing
 *  between the read and the write keeps the newer hand-out held. */
function sameHandOut(seen: readonly SeenHandOut[]) {
	return sql`exists (select 1 from json_each(${JSON.stringify(seen)}) where json_extract(value, '$.turfId') = ${vanTurfs.turfId} and json_extract(value, '$.since') is ${vanTurfs.vanAssignedAt})`;
}

/** Why each turf in `seen` was not released: the first of what holds it that
 *  applies. */
async function whyNotReleased(
	db: Db,
	seen: readonly SeenHandOut[],
	now: Date,
): Promise<Map<number, VanSkipReason>> {
	const rows =
		seen.length === 0
			? []
			: await db
					.select({
						turfId: vanTurfs.turfId,
						vanDistributedTo: vanTurfs.vanDistributedTo,
						vanAssignedAt: vanTurfs.vanAssignedAt,
						sheetAssignedTo: vanTurfs.sheetAssignedTo,
						claimed: sql<number>`${liveClaim(now)}`,
					})
					.from(vanTurfs)
					.where(sql`${vanTurfs.turfId} in (${idRows(seen.map((s) => s.turfId))})`);
	const byId = new Map(rows.map((row) => [row.turfId, row]));
	return new Map(
		seen.map(({ turfId, since }): [number, VanSkipReason] => {
			const row = byId.get(turfId);
			if (!row) return [turfId, 'not-found'];
			if (row.claimed) return [turfId, 'claimed'];
			if (row.sheetAssignedTo) return [turfId, 'sheet'];
			if (row.vanDistributedTo && row.vanAssignedAt !== since) return [turfId, 'changed'];
			return [turfId, 'not-held'];
		}),
	);
}

/** Release `turfId` from the outside VAN hand-out made at `seen.since`, as
 *  the card built at `seen.seenAt` showed it. */
export async function releaseVanAssignment(
	db: Db,
	turfId: number,
	seen: { since: string | null; seenAt: Date },
	editor: { id: string; name: string },
	now: Date,
	vanAssignmentTtlHours: number,
): Promise<VanReleaseResult> {
	const handOut = [{ turfId, since: seen.since }];
	const held = await stillHeld(db, eq(vanTurfs.turfId, turfId), now, vanAssignmentTtlHours);
	const updated =
		held.length === 0 || held[0]!.since !== seen.since
			? []
			: await db
					.update(vanTurfs)
					.set(releaseStamp(seenBy(seen.seenAt, now), editor))
					.where(and(eq(vanTurfs.turfId, turfId), heldOnlyInVanWhere(now), sameHandOut(handOut)))
					.returning({ turfId: vanTurfs.turfId });
	if (updated.length === 0) return (await whyNotReleased(db, handOut, now)).get(turfId)!;
	console.log(
		`[van] turf ${turfId} released from its VAN hand-out by ${editor.id} (${editor.name})`,
	);
	return 'released';
}

/** Turf the bulk release would free: held only in VAN, outside the
 *  requested-turf folder, and still out of the pool. */
export async function vanOnlyHeldTurfs(
	db: Db,
	now: Date,
	vanAssignmentTtlHours: number,
): Promise<VanHeldTurf[]> {
	return stillHeld(db, inBulkRelease(), now, vanAssignmentTtlHours);
}

/** Release the turf in `seen` that `vanOnlyHeldTurfs` still finds under the
 *  hand-out the caller saw when it counted them at `countedAt`, in one
 *  statement, so a failure releases none of them. */
export async function releaseAllVanAssignments(
	db: Db,
	seen: readonly SeenHandOut[],
	countedAt: Date,
	editor: { id: string; name: string },
	now: Date,
	vanAssignmentTtlHours: number,
): Promise<VanReleaseOutcome> {
	const wanted = new Map(seen.map((s) => [s.turfId, s.since]));
	const held = await stillHeld(
		db,
		and(sql`${vanTurfs.turfId} in (${idRows([...wanted.keys()])})`, inBulkRelease()),
		now,
		vanAssignmentTtlHours,
	);
	const release = held
		.filter((t) => wanted.get(t.turfId) === t.since)
		.map((t) => ({ turfId: t.turfId, since: t.since }));
	const updated =
		release.length === 0
			? []
			: await db
					.update(vanTurfs)
					.set(releaseStamp(seenBy(countedAt, now), editor))
					.where(
						and(
							sql`${vanTurfs.turfId} in (${idRows(release.map((t) => t.turfId))})`,
							heldOnlyInVanWhere(now),
							inBulkRelease(),
							sameHandOut(release),
						),
					)
					.returning({ turfId: vanTurfs.turfId });
	console.log(
		`[van] ${updated.length} turf released from VAN hand-outs by ${editor.id} (${editor.name})`,
	);
	const freed = new Set(updated.map((u) => u.turfId));
	const left = [...wanted].flatMap(([turfId, since]) =>
		freed.has(turfId) ? [] : [{ turfId, since }],
	);
	const skipped: VanReleaseOutcome['skipped'] = {};
	for (const reason of (await whyNotReleased(db, left, now)).values()) {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	}
	return { released: updated.length, skipped };
}

/** One VAN folder's line in the bulk release's summary. */
export interface VanReleaseFolder {
	campaignId: number;
	/** The campaign's name, when the turf spans more than one campaign. */
	campaign: string | null;
	folderId: number;
	/** VAN's name for the folder; null when VAN could not be asked. */
	name: string | null;
	/** The chapter the folder's turf is filed under here. */
	chapterName: string;
	count: number;
}

/** `turfs` counted by VAN folder, largest first, then by campaign and name. Folder ids are only unique
 *  within one campaign, so the campaign is part of the key. */
export function countByFolder(
	turfs: readonly VanHeldTurf[],
	folderNames: ReadonlyMap<number, ReadonlyMap<number, string>>,
	campaignNames: ReadonlyMap<number, string>,
): VanReleaseFolder[] {
	const multiCampaign = new Set(turfs.map((t) => t.campaignId)).size > 1;
	const folders = new Map<string, VanReleaseFolder>();
	for (const turf of turfs) {
		const key = `${turf.campaignId}:${turf.folderId}`;
		const folder = folders.get(key);
		if (folder) {
			folder.count += 1;
			continue;
		}
		folders.set(key, {
			campaignId: turf.campaignId,
			campaign: multiCampaign ? (campaignNames.get(turf.campaignId) ?? null) : null,
			folderId: turf.folderId,
			name: folderNames.get(turf.campaignId)?.get(turf.folderId)?.trim() || null,
			chapterName: turf.chapterName,
			count: 1,
		});
	}
	return [...folders.values()].sort(
		(a, b) =>
			b.count - a.count ||
			(a.campaign ?? '').localeCompare(b.campaign ?? '') ||
			a.campaignId - b.campaignId ||
			(a.name ?? a.chapterName).localeCompare(b.name ?? b.chapterName) ||
			a.folderId - b.folderId,
	);
}

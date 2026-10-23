// Which chapter each requested turf goes to.
//
// Organizers cut volunteers' turf requests into one VAN folder per campaign
// (van_campaigns.requested_folder_id). Mapping that folder to every chapter
// would show every chapter every request; mapping it to none would show them
// to nobody. So each turf in it is placed in ONE chapter, by where it is:
//
//   1. The ZIP its location falls in (the Census, zipForPoint), then that ZIP's
//      chapter in zip_chapter_map — built nightly from where members live, so
//      it owes nothing to how VAN folders are filed. Some folders have had
//      turf from across the state filed in them by mistake, which is why the
//      folder mapping is not the first resort.
//   2. Failing that — a ZIP with no members, a chapter not offered for turf, or
//      the Census not answering — the chapter most of the NEARBY_TURF_VOTES
//      nearest regular turf belongs to, counting only turf within
//      NEARBY_RADIUS_MILES. A vote rather than the single nearest, so one
//      misfiled turf next door cannot decide it; and within a radius, so
//      where turf is sparse a city an hour away cannot outvote the few
//      neighbours there are. With none that close, the nearest decides.
//   3. An organizer's choice, from /turfs/organizer, which nothing here
//      overwrites.
//
// A requested folder an admin has also mapped to chapters is seen by those
// chapters as well: placement adds a chapter, it does not take any away.
//
// A turf needs a location for 1 and 2, so it is placed only once its shape has
// been built (geometry-worker.ts), and until then no chapter sees it (see
// chapter-visibility.ts). It is placed again when its location changes, and a
// placement made by vote because the Census was down is tried by ZIP again.
//
// Placed turf also takes its chapter as the row's display label (van_turfs
// .chapter_id), which the catalog sync keeps rather than overwriting (see the
// `placements` input in catalog.ts).
//
// Free of settings and env imports so the sync, the press and the tests can
// all run it: the chapters turf may go to are passed in.

import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import {
	vanCampaigns,
	vanChapterFolders,
	vanTurfPlacements,
	vanTurfs,
	zipChapterMap,
	type VanTurfPlacementRow,
} from '../schema.js';
import { haversineMeters, type LatLng } from '../../van/geometry.js';
import { zipForPoint } from './zip-centroid.js';

type Db = ReturnType<typeof drizzle>;

/** Nearest regular turf that vote, when the ZIP cannot place a turf. */
export const NEARBY_TURF_VOTES = 15;
/** How far a voter may be. A county chapter's turf is rarely further apart. */
export const NEARBY_RADIUS_MILES = 10;
const NEARBY_RADIUS_METRES = NEARBY_RADIUS_MILES * 1609.344;

/** Shown for requested turf no chapter has yet. */
export const UNPLACED_LABEL = 'Requested turf (not placed yet)';

const DEFAULT_TIME_BUDGET_MS = 30 * 1000;

/** A chapter requested turf may be placed in: one the turf pickers offer. */
export interface PlacementChapter {
	chapterId: number;
	name: string;
}

export interface PlacementResult {
	byZip: number;
	byNearby: number;
	/** Had a location but nothing could place it; tried again next run. */
	unplaced: number;
	/** Placements dropped because their turf is no longer in the folder. */
	cleared: number;
	budgetLapsed: boolean;
}

export interface PlacementOptions {
	/** The chapters turf may go to — turfChapters() of the settings. */
	chapters: readonly PlacementChapter[];
	/** Only these turfs: an organizer's "back to automatic". */
	turfIds?: readonly number[];
	fetchFn?: typeof fetch;
	timeBudgetMs?: number;
	now?: Date;
}

/** Turf that votes in the fallback: its location and the chapters it is in. */
interface Voter {
	at: LatLng;
	chapterIds: number[];
}

/**
 * Place the campaign's requested turf that needs it. Never throws for one
 * turf; a thrown error means the database is unreachable.
 */
export async function placeRequestedTurf(
	db: Db,
	campaign: { id: number; requestedFolderId: number | null },
	options: PlacementOptions,
): Promise<PlacementResult> {
	const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
	const now = (options.now ?? new Date()).toISOString();
	const result: PlacementResult = {
		byZip: 0,
		byNearby: 0,
		unplaced: 0,
		cleared: 0,
		budgetLapsed: false,
	};

	result.cleared = await clearStale(db, campaign);
	if (campaign.requestedFolderId === null) return result;

	const offered = new Map(options.chapters.map((c) => [c.chapterId, c.name]));
	const candidates = await db
		.select({
			turfId: vanTurfs.turfId,
			lat: vanTurfs.centroidLat,
			lng: vanTurfs.centroidLng,
		})
		.from(vanTurfs)
		.leftJoin(vanTurfPlacements, eq(vanTurfPlacements.turfId, vanTurfs.turfId))
		.where(
			and(
				eq(vanTurfs.campaignId, campaign.id),
				eq(vanTurfs.folderId, campaign.requestedFolderId),
				isNull(vanTurfs.retiredAt),
				isNotNull(vanTurfs.centroidLat),
				isNotNull(vanTurfs.centroidLng),
				options.turfIds ? inArray(vanTurfs.turfId, [...options.turfIds]) : undefined,
				or(
					isNull(vanTurfPlacements.turfId),
					and(
						ne(vanTurfPlacements.source, 'organizer'),
						or(
							// Moved: a re-cut, or its first real shape after a pin.
							sql`${vanTurfPlacements.centroidLat} is not ${vanTurfs.centroidLat}`,
							sql`${vanTurfPlacements.centroidLng} is not ${vanTurfs.centroidLng}`,
							// Placed by vote only because the Census did not answer.
							and(eq(vanTurfPlacements.source, 'nearby'), eq(vanTurfPlacements.zipChecked, false)),
						),
					),
				),
			),
		)
		.orderBy(vanTurfs.turfId);
	if (candidates.length === 0) return result;

	let voters: Voter[] | null = null;
	for (const turf of candidates) {
		if (Date.now() >= deadline) {
			result.budgetLapsed = true;
			break;
		}
		const at = { lat: turf.lat!, lng: turf.lng! };

		const lookup = await zipForPoint(at, options.fetchFn);
		const zip = lookup.ok ? lookup.zip : null;
		let placement: Pick<VanTurfPlacementRow, 'chapterId' | 'chapterName' | 'source'> | null = null;
		if (zip) {
			const [row] = await db
				.select({ chapterId: zipChapterMap.chapterId })
				.from(zipChapterMap)
				.where(eq(zipChapterMap.zipCode, zip));
			const name = row ? offered.get(row.chapterId) : undefined;
			if (row && name !== undefined) {
				placement = { chapterId: row.chapterId, chapterName: name, source: 'zip' };
			}
		}
		if (!placement) {
			voters ??= await loadVoters(db, offered);
			const chapterId = nearbyVote(at, voters);
			if (chapterId !== null) {
				placement = { chapterId, chapterName: offered.get(chapterId)!, source: 'nearby' };
			}
		}
		if (!placement) {
			result.unplaced++;
			continue;
		}

		const written = await writeAutomaticPlacement(db, turf.turfId, {
			...placement,
			zip,
			zipChecked: lookup.ok,
			centroidLat: at.lat,
			centroidLng: at.lng,
			placedAt: now,
			placedByName: null,
		});
		if (!written) continue;
		if (placement.source === 'zip') result.byZip++;
		else result.byNearby++;
	}
	return result;
}

/**
 * The chapter most of the nearest NEARBY_TURF_VOTES voters within
 * NEARBY_RADIUS_MILES are in; on a tie, the one whose voter is nearest. With
 * no voter that close, the nearest voter's. Null when there are no voters.
 *
 * A voter mapped to several chapters votes for each: a folder shared by two
 * chapters is turf both of them canvass.
 */
export function nearbyVote(at: LatLng, voters: readonly Voter[]): number | null {
	const sorted = voters
		.map((v) => ({ v, d: haversineMeters(at, v.at) }))
		.sort((a, b) => a.d - b.d)
		.slice(0, NEARBY_TURF_VOTES);
	const close = sorted.filter((s) => s.d <= NEARBY_RADIUS_METRES);
	const nearest = close.length > 0 ? close : sorted.slice(0, 1);
	const votes = new Map<number, { count: number; rank: number }>();
	nearest.forEach(({ v }, rank) => {
		for (const chapterId of v.chapterIds) {
			const tally = votes.get(chapterId);
			if (tally) tally.count++;
			else votes.set(chapterId, { count: 1, rank });
		}
	});
	let best: { chapterId: number; count: number; rank: number } | null = null;
	for (const [chapterId, tally] of votes) {
		if (
			!best ||
			tally.count > best.count ||
			(tally.count === best.count && tally.rank < best.rank)
		) {
			best = { chapterId, ...tally };
		}
	}
	return best?.chapterId ?? null;
}

/** Regular turf with a location, and the offered chapters each is in. Every
 *  campaign's: a chapter is a place, whichever campaign cut the turf. */
async function loadVoters(db: Db, offered: ReadonlyMap<number, string>): Promise<Voter[]> {
	const folders = await db
		.select({
			campaignId: vanChapterFolders.campaignId,
			folderId: vanChapterFolders.folderId,
			chapterId: vanChapterFolders.chapterId,
		})
		.from(vanChapterFolders);
	const chaptersOf = new Map<string, number[]>();
	for (const f of folders) {
		if (!offered.has(f.chapterId)) continue;
		const key = `${f.campaignId}:${f.folderId}`;
		chaptersOf.set(key, [...(chaptersOf.get(key) ?? []), f.chapterId]);
	}

	const rows = await db
		.select({
			campaignId: vanTurfs.campaignId,
			folderId: vanTurfs.folderId,
			lat: vanTurfs.centroidLat,
			lng: vanTurfs.centroidLng,
		})
		.from(vanTurfs)
		.where(
			and(
				isNull(vanTurfs.retiredAt),
				isNotNull(vanTurfs.centroidLat),
				isNotNull(vanTurfs.centroidLng),
				// Other requested turf is placed, not mapped: it has no vote.
				sql`not exists (select 1 from ${vanCampaigns} where ${vanCampaigns.id} = ${vanTurfs.campaignId} and ${vanCampaigns.requestedFolderId} = ${vanTurfs.folderId})`,
			),
		);
	return rows.flatMap((r) => {
		const chapterIds = chaptersOf.get(`${r.campaignId}:${r.folderId}`);
		return chapterIds ? [{ at: { lat: r.lat!, lng: r.lng! }, chapterIds }] : [];
	});
}

/**
 * Store an automatic placement, unless an organizer has placed the turf since
 * this run read it — the Census lookup in between takes long enough for one
 * to. Their choice stands, and so does the label it gave the turf. Returns
 * whether this one was written.
 */
async function writeAutomaticPlacement(
	db: Db,
	turfId: number,
	row: Omit<VanTurfPlacementRow, 'turfId'>,
): Promise<boolean> {
	const [stored] = await db.batch([
		db
			.insert(vanTurfPlacements)
			.values({ turfId, ...row })
			.onConflictDoUpdate({
				target: vanTurfPlacements.turfId,
				set: row,
				setWhere: ne(vanTurfPlacements.source, 'organizer'),
			})
			.returning({ turfId: vanTurfPlacements.turfId }),
		db
			.update(vanTurfs)
			.set({ chapterId: row.chapterId, chapterName: row.chapterName })
			.where(
				and(
					eq(vanTurfs.turfId, turfId),
					sql`not exists (select 1 from ${vanTurfPlacements} where ${vanTurfPlacements.turfId} = ${turfId} and ${vanTurfPlacements.source} = 'organizer')`,
				),
			),
	]);
	return stored.length > 0;
}

/** Store a placement, and give the turf its chapter as its display label. */
async function writePlacement(
	db: Db,
	turfId: number,
	row: Omit<VanTurfPlacementRow, 'turfId'>,
): Promise<void> {
	await db.batch([
		db
			.insert(vanTurfPlacements)
			.values({ turfId, ...row })
			.onConflictDoUpdate({ target: vanTurfPlacements.turfId, set: row }),
		db
			.update(vanTurfs)
			.set({ chapterId: row.chapterId, chapterName: row.chapterName })
			.where(eq(vanTurfs.turfId, turfId)),
	]);
}

/**
 * Drop placements of this campaign's turf that is no longer in its requested
 * folder — the folder was changed or cleared — so a chapter does not keep
 * seeing turf by a placement nobody would make now. Its label goes back to the
 * placeholder too; a turf in a mapped folder gets its folder's chapter again
 * on the next catalog sync.
 */
async function clearStale(
	db: Db,
	campaign: { id: number; requestedFolderId: number | null },
): Promise<number> {
	const stale = await db
		.select({ turfId: vanTurfPlacements.turfId, folderId: vanTurfs.folderId })
		.from(vanTurfPlacements)
		.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanTurfPlacements.turfId))
		.where(
			and(
				eq(vanTurfs.campaignId, campaign.id),
				campaign.requestedFolderId === null
					? undefined
					: ne(vanTurfs.folderId, campaign.requestedFolderId),
			),
		);
	if (stale.length === 0) return 0;
	const ids = stale.map((s) => s.turfId);
	const byFolder = new Map<number, number[]>();
	for (const s of stale) byFolder.set(s.folderId, [...(byFolder.get(s.folderId) ?? []), s.turfId]);
	const labels = await Promise.all(
		[...byFolder].map(async ([folderId, turfIds]) => ({
			turfIds,
			label: await unplacedLabel(db, campaign.id, folderId),
		})),
	);
	// Built here, not inside the map above: a builder returned from an async
	// function is a thenable, so it would be awaited — run — there.
	const relabels = labels.map(({ turfIds, label }) =>
		db.update(vanTurfs).set(label).where(inArray(vanTurfs.turfId, turfIds)),
	);
	await db.batch([
		db.delete(vanTurfPlacements).where(inArray(vanTurfPlacements.turfId, ids)),
		...relabels,
	]);
	return ids.length;
}

/**
 * The label for turf with no placement: the chapter its folder is mapped to,
 * chosen as the catalog chooses it (a real chapter over a turf-only one, then
 * by name — see runCatalogSync), so the next sync does not change it; or the
 * "not placed yet" placeholder for a folder mapped to none.
 */
async function unplacedLabel(
	db: Db,
	campaignId: number,
	folderId: number,
): Promise<{ chapterId: number; chapterName: string }> {
	const mapped = await db
		.select({ chapterId: vanChapterFolders.chapterId, chapterName: vanChapterFolders.chapterName })
		.from(vanChapterFolders)
		.where(
			and(eq(vanChapterFolders.campaignId, campaignId), eq(vanChapterFolders.folderId, folderId)),
		);
	// localeCompare, as loadVanChapterFolders sorts the catalog's mapping —
	// not SQL's ORDER BY, which puts "Dearborn" before "de Soto".
	mapped.sort((a, b) => a.chapterName.localeCompare(b.chapterName));
	const owner = mapped.find((m) => m.chapterId > 0) ?? mapped[0];
	return owner ?? { chapterId: 0, chapterName: UNPLACED_LABEL };
}

/**
 * An organizer's placement of one requested turf: a chapter, or null to hand
 * it back to the automatic placement. Returns the turf's campaign, for the
 * caller to place it again straight away; null when the turf is not requested
 * turf (not in its campaign's requested folder), so the caller can refuse.
 */
export async function setOrganizerPlacement(
	db: Db,
	turfId: number,
	chapter: PlacementChapter | null,
	editorName: string,
	now: Date = new Date(),
): Promise<{ id: number; requestedFolderId: number | null } | null> {
	const [turf] = await db
		.select({
			turfId: vanTurfs.turfId,
			lat: vanTurfs.centroidLat,
			lng: vanTurfs.centroidLng,
			campaignId: vanCampaigns.id,
			requestedFolderId: vanCampaigns.requestedFolderId,
			folderId: vanTurfs.folderId,
		})
		.from(vanTurfs)
		.innerJoin(vanCampaigns, eq(vanCampaigns.id, vanTurfs.campaignId))
		.where(and(eq(vanTurfs.turfId, turfId), eq(vanCampaigns.requestedFolderId, vanTurfs.folderId)));
	if (!turf) return null;
	const campaign = { id: turf.campaignId, requestedFolderId: turf.requestedFolderId };

	if (chapter === null) {
		const label = await unplacedLabel(db, turf.campaignId, turf.folderId);
		await db.batch([
			db.delete(vanTurfPlacements).where(eq(vanTurfPlacements.turfId, turfId)),
			db.update(vanTurfs).set(label).where(eq(vanTurfs.turfId, turfId)),
		]);
		return campaign;
	}
	await writePlacement(db, turfId, {
		chapterId: chapter.chapterId,
		chapterName: chapter.name,
		source: 'organizer',
		zip: null,
		zipChecked: false,
		centroidLat: turf.lat,
		centroidLng: turf.lng,
		placedAt: now.toISOString(),
		placedByName: editorName,
	});
	return campaign;
}

/** Requested turf as /turfs/organizer lists it. */
export interface RequestedTurfRow {
	turfId: number;
	campaignId: number;
	name: string;
	regionName: string;
	/** It has a location, so the automatic placement can work on it. */
	located: boolean;
	placement: Pick<
		VanTurfPlacementRow,
		'chapterId' | 'chapterName' | 'source' | 'zip' | 'placedByName' | 'placedAt'
	> | null;
}

/** Every enabled campaign's live requested turf, unplaced first: at most
 *  `limit` rows, and how many there are in all, so the page can say what it
 *  left out. */
export async function loadRequestedTurf(
	db: Db,
	limit = 300,
): Promise<{ turfs: RequestedTurfRow[]; total: number }> {
	const scope = and(
		eq(vanCampaigns.enabled, true),
		eq(vanCampaigns.requestedFolderId, vanTurfs.folderId),
		isNull(vanTurfs.retiredAt),
	);
	const rows = await db
		.select({
			turfId: vanTurfs.turfId,
			campaignId: vanTurfs.campaignId,
			name: vanTurfs.name,
			regionName: vanTurfs.regionName,
			centroidLat: vanTurfs.centroidLat,
			placement: vanTurfPlacements,
		})
		.from(vanTurfs)
		.innerJoin(vanCampaigns, eq(vanCampaigns.id, vanTurfs.campaignId))
		.leftJoin(vanTurfPlacements, eq(vanTurfPlacements.turfId, vanTurfs.turfId))
		.where(scope)
		.orderBy(sql`${vanTurfPlacements.turfId} is not null`, vanTurfs.name)
		.limit(limit);
	const total =
		rows.length < limit
			? rows.length
			: Number(
					(
						await db
							.select({ n: sql<number>`count(*)` })
							.from(vanTurfs)
							.innerJoin(vanCampaigns, eq(vanCampaigns.id, vanTurfs.campaignId))
							.where(scope)
					)[0]?.n ?? rows.length,
				);
	const turfs = rows.map((r) => ({
		turfId: r.turfId,
		campaignId: r.campaignId,
		name: r.name,
		regionName: r.regionName,
		located: r.centroidLat !== null,
		placement: r.placement
			? {
					chapterId: r.placement.chapterId,
					chapterName: r.placement.chapterName,
					source: r.placement.source,
					zip: r.placement.zip,
					placedByName: r.placement.placedByName,
					placedAt: r.placement.placedAt,
				}
			: null,
	}));
	return { turfs, total };
}

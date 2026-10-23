import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, isNull } from 'drizzle-orm';
import { vanTurfs } from '../schema.js';
import { visibleToAnyChapter, visibleToChapter } from './chapter-visibility.js';
import {
	NEARBY_TURF_VOTES,
	UNPLACED_LABEL,
	loadRequestedTurf,
	nearbyVote,
	placeRequestedTurf,
	setOrganizerPlacement,
} from './turf-placement.js';

// A real in-memory libsql with the real schema: placement is a collaboration
// between this module's writes and the visibility subquery that reads them.

let db: ReturnType<typeof drizzle>;
let client: Client;
const AT = '2026-10-22T00:00:00.000Z';
const REQUESTED = 900;
const CAMPAIGN = { id: 1, requestedFolderId: REQUESTED };
const CHAPTERS = [
	{ chapterId: 71, name: 'Washtenaw County' },
	{ chapterId: 72, name: 'Wayne County' },
];
/** Ann Arbor, and Detroit — a long way apart. */
const ANN_ARBOR = { lat: 42.28, lng: -83.74 };
const DETROIT = { lat: 42.33, lng: -83.05 };

async function turf(
	turfId: number,
	folderId: number,
	at: { lat: number; lng: number } | null,
	campaignId = 1,
): Promise<void> {
	await client.execute({
		sql: `INSERT INTO van_turfs (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name, name, door_count, centroid_lat, centroid_lng, first_seen_at, last_seen_at)
		 VALUES (?, ?, ?, 1, ?, 0, ?, 'Region', ?, 100, ?, ?, ?, ?)`,
		args: [
			turfId,
			campaignId,
			turfId,
			folderId,
			UNPLACED_LABEL,
			`Turf ${turfId}`,
			at?.lat ?? null,
			at?.lng ?? null,
			AT,
			AT,
		],
	});
}

async function map(chapterId: number, folderId: number): Promise<void> {
	await client.execute(
		`INSERT INTO van_chapter_folders (campaign_id, chapter_id, folder_id, chapter_name, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (1, ${chapterId}, ${folderId}, 'Chapter ${chapterId}', 'U', 'Alice', '${AT}')`,
	);
}

async function zipChapter(zip: string, chapterId: number): Promise<void> {
	await client.execute(
		`INSERT INTO zip_chapter_map (zip_code, chapter_id, member_count, updated_at) VALUES ('${zip}', ${chapterId}, 5, '${AT}')`,
	);
}

/** A Census that answers `zip` for every point, or fails outright. */
function census(zip: string | null | 'down') {
	return vi.fn(async () =>
		zip === 'down'
			? new Response('busy', { status: 503 })
			: Response.json({ features: zip ? [{ attributes: { ZCTA5: zip } }] : [] }),
	) as unknown as typeof fetch;
}

async function place(fetchFn: typeof fetch, turfIds?: number[]) {
	return placeRequestedTurf(db, CAMPAIGN, { chapters: CHAPTERS, fetchFn, turfIds });
}

async function visible(chapterId: number): Promise<number[]> {
	const rows = await db
		.select({ turfId: vanTurfs.turfId })
		.from(vanTurfs)
		.where(and(visibleToChapter(chapterId), isNull(vanTurfs.retiredAt)));
	return rows.map((r) => r.turfId).sort((a, b) => a - b);
}

async function label(turfId: number) {
	const { rows } = await client.execute(
		`SELECT chapter_id, chapter_name FROM van_turfs WHERE turf_id = ${turfId}`,
	);
	return rows[0];
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await client.execute(`UPDATE van_campaigns SET requested_folder_id = ${REQUESTED} WHERE id = 1`);
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	// Regular turf: Washtenaw's folder around Ann Arbor, Wayne's around Detroit.
	await map(71, 10);
	await map(72, 20);
	for (let i = 0; i < 5; i++) {
		await turf(100 + i, 10, { lat: ANN_ARBOR.lat + i * 0.001, lng: ANN_ARBOR.lng });
		await turf(200 + i, 20, { lat: DETROIT.lat + i * 0.001, lng: DETROIT.lng });
	}
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

describe('placeRequestedTurf', () => {
	it('places requested turf by the ZIP it falls in, and only that chapter sees it', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 71);
		const result = await place(census('48104'));
		expect(result).toMatchObject({ byZip: 1, byNearby: 0, unplaced: 0 });
		expect(await visible(71)).toContain(500);
		expect(await visible(72)).not.toContain(500);
		expect(await label(500)).toMatchObject({ chapter_id: 71, chapter_name: 'Washtenaw County' });
	});

	it('shows unplaced requested turf to no chapter', async () => {
		await turf(500, REQUESTED, null);
		await place(census('48104'));
		expect(await visible(71)).not.toContain(500);
		expect(await visible(72)).not.toContain(500);
	});

	it('falls back to the turf around it when the ZIP has no chapter', async () => {
		await turf(500, REQUESTED, { lat: DETROIT.lat + 0.002, lng: DETROIT.lng });
		const result = await place(census('48201'));
		expect(result).toMatchObject({ byZip: 0, byNearby: 1 });
		expect(await visible(72)).toContain(500);
	});

	it('falls back when the ZIP’s chapter is not offered for turf', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 4242);
		await place(census('48104'));
		expect(await visible(71)).toContain(500);
	});

	// Some folders hold turf from across the state by mistake. One such turf
	// next door must not decide it.
	it('is not swayed by one misfiled turf right beside it', async () => {
		await turf(299, 20, { lat: ANN_ARBOR.lat, lng: ANN_ARBOR.lng + 0.0001 });
		await turf(500, REQUESTED, ANN_ARBOR);
		await place(census(null));
		expect(await visible(71)).toContain(500);
		expect(await visible(72)).not.toContain(500);
	});

	it('does not let other requested turf vote', async () => {
		for (let i = 0; i < 10; i++) {
			await turf(600 + i, REQUESTED, { lat: ANN_ARBOR.lat, lng: ANN_ARBOR.lng + i * 0.0001 });
		}
		await client.execute(
			`INSERT INTO van_turf_placements (turf_id, chapter_id, chapter_name, source, zip_checked, centroid_lat, centroid_lng, placed_at)
			 SELECT turf_id, 72, 'Wayne County', 'organizer', 0, centroid_lat, centroid_lng, '${AT}' FROM van_turfs WHERE folder_id = ${REQUESTED}`,
		);
		await turf(500, REQUESTED, ANN_ARBOR);
		await place(census(null));
		expect(await visible(71)).toContain(500);
	});

	// Tried by ZIP again next run, rather than kept by vote for good.
	it('places by vote while the Census is down, then by ZIP once it answers', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 72);
		await place(census('down'));
		expect(await visible(71)).toContain(500);
		await place(census('48104'));
		expect(await visible(72)).toContain(500);
		expect(await visible(71)).not.toContain(500);
	});

	it('does not ask again about turf already placed where it still is', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 71);
		await place(census('48104'));
		const again = census('48104');
		await place(again);
		expect(again).not.toHaveBeenCalled();
	});

	it('places turf again when its location changes', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 71);
		await zipChapter('48201', 72);
		await place(census('48104'));
		await client.execute(
			`UPDATE van_turfs SET centroid_lat = ${DETROIT.lat}, centroid_lng = ${DETROIT.lng} WHERE turf_id = 500`,
		);
		await place(census('48201'));
		expect(await visible(72)).toContain(500);
	});

	it('never moves an organizer’s placement', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 71);
		await setOrganizerPlacement(db, 500, { chapterId: 72, name: 'Wayne County' }, 'Alex');
		const fetchFn = census('48104');
		await place(fetchFn);
		expect(fetchFn).not.toHaveBeenCalled();
		expect(await visible(72)).toContain(500);
		expect(await label(500)).toMatchObject({ chapter_id: 72 });
	});

	// Mapped to chapters too, those chapters keep seeing all of it; its ZIP's
	// chapter sees it as well.
	it('adds the ZIP’s chapter to the chapters a mapped requested folder already has', async () => {
		await map(71, REQUESTED);
		await turf(500, REQUESTED, DETROIT);
		await zipChapter('48201', 72);
		await place(census('48201'));
		expect(await visible(71)).toContain(500);
		expect(await visible(72)).toContain(500);
		expect(await label(500)).toMatchObject({ chapter_id: 72 });
	});

	// The Census lookup takes long enough for an organizer to pick a chapter
	// in the middle of a run. Their choice must stand.
	it('leaves an organizer’s placement made while the run was asking the Census', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 71);
		const fetchFn = vi.fn(async () => {
			await setOrganizerPlacement(db, 500, CHAPTERS[1]!, 'Alex');
			return Response.json({ features: [{ attributes: { ZCTA5: '48104' } }] });
		}) as unknown as typeof fetch;
		const result = await place(fetchFn);
		expect(result.byZip).toBe(0);
		expect(await visible(72)).toContain(500);
		expect(await visible(71)).not.toContain(500);
		expect(await label(500)).toMatchObject({ chapter_id: 72 });
	});

	it('clears placements when the folder is no longer the requested one', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 71);
		await place(census('48104'));
		const result = await placeRequestedTurf(
			db,
			{ id: 1, requestedFolderId: null },
			{ chapters: CHAPTERS, fetchFn: census('48104') },
		);
		expect(result.cleared).toBe(1);
		expect(await visible(71)).not.toContain(500);
		expect(await label(500)).toMatchObject({ chapter_id: 0, chapter_name: UNPLACED_LABEL });
	});

	it('leaves retired requested turf alone', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await client.execute(`UPDATE van_turfs SET retired_at = '${AT}' WHERE turf_id = 500`);
		const fetchFn = census('48104');
		await place(fetchFn);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('works through only the turf it is given', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await turf(501, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 71);
		await place(census('48104'), [501]);
		expect(await visible(71)).toEqual(expect.arrayContaining([501]));
		expect(await visible(71)).not.toContain(500);
	});

	it('is seen by visibleToAnyChapter too, for the signed-out teaser', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 71);
		await place(census('48104'));
		const rows = await db
			.select({ turfId: vanTurfs.turfId })
			.from(vanTurfs)
			.where(visibleToAnyChapter([71]));
		expect(rows.map((r) => r.turfId)).toContain(500);
	});
});

describe('setOrganizerPlacement', () => {
	it('refuses turf outside the requested folder', async () => {
		expect(await setOrganizerPlacement(db, 100, CHAPTERS[1]!, 'Alex')).toBeNull();
	});

	it('hands turf back to automatic, unplaced until placed again', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await setOrganizerPlacement(db, 500, CHAPTERS[1]!, 'Alex');
		expect(await setOrganizerPlacement(db, 500, null, 'Alex')).toEqual(CAMPAIGN);
		expect(await visible(72)).not.toContain(500);
		expect(await label(500)).toMatchObject({ chapter_id: 0, chapter_name: UNPLACED_LABEL });
	});

	// The label the next catalog sync would give it, so nothing flips.
	it('hands mapped turf back with its mapped chapter as its label', async () => {
		await map(71, REQUESTED);
		await turf(500, REQUESTED, null);
		await setOrganizerPlacement(db, 500, CHAPTERS[1]!, 'Alex');
		await setOrganizerPlacement(db, 500, null, 'Alex');
		expect(await label(500)).toMatchObject({ chapter_id: 71, chapter_name: 'Chapter 71' });
		expect(await visible(71)).toContain(500);
		expect(await visible(72)).not.toContain(500);
	});

	// SQL's ORDER BY and the catalog's localeCompare disagree on these two.
	it('picks the mapped label the catalog would', async () => {
		for (const [chapterId, name] of [
			[72, 'Dearborn'],
			[71, 'de Soto Chapter'],
		] as const) {
			await client.execute(
				`INSERT INTO van_chapter_folders (campaign_id, chapter_id, folder_id, chapter_name, last_edited_by, last_edited_by_name, last_edited_at)
				 VALUES (1, ${chapterId}, ${REQUESTED}, '${name}', 'U', 'Alice', '${AT}')`,
			);
		}
		await turf(500, REQUESTED, null);
		await setOrganizerPlacement(db, 500, null, 'Alex');
		expect(await label(500)).toMatchObject({ chapter_id: 71, chapter_name: 'de Soto Chapter' });
		expect(['de Soto Chapter', 'Dearborn'].sort((a, b) => a.localeCompare(b))[0]).toBe(
			'de Soto Chapter',
		);
	});

	it('can place turf that has no location yet', async () => {
		await turf(500, REQUESTED, null);
		await setOrganizerPlacement(db, 500, CHAPTERS[0]!, 'Alex');
		expect(await visible(71)).toContain(500);
	});
});

describe('loadRequestedTurf', () => {
	it('lists requested turf, unplaced first, with its placement', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await turf(501, REQUESTED, null);
		await zipChapter('48104', 71);
		await place(census('48104'));
		const { turfs, total } = await loadRequestedTurf(db);
		expect(turfs.map((r) => [r.turfId, r.located, r.placement?.source ?? null])).toEqual([
			[501, false, null],
			[500, true, 'zip'],
		]);
		expect(total).toBe(2);
	});

	it('says how many there are when it shows only some', async () => {
		for (let i = 0; i < 3; i++) await turf(500 + i, REQUESTED, null);
		const { turfs, total } = await loadRequestedTurf(db, 2);
		expect(turfs).toHaveLength(2);
		expect(total).toBe(3);
	});
});

describe('nearbyVote', () => {
	const at = { lat: 0, lng: 0 };
	const voter = (lng: number, chapterIds: number[]) => ({ at: { lat: 0, lng }, chapterIds });

	it('takes the chapter most of the nearest turf is in', () => {
		expect(nearbyVote(at, [voter(0.001, [72]), voter(0.002, [71]), voter(0.003, [71])])).toBe(71);
	});

	it('breaks a tie by the nearest', () => {
		expect(nearbyVote(at, [voter(0.002, [71]), voter(0.001, [72])])).toBe(72);
	});

	it(`counts only the nearest ${NEARBY_TURF_VOTES}`, () => {
		const near = Array.from({ length: NEARBY_TURF_VOTES }, (_, i) => voter(0.001 + i * 1e-5, [72]));
		const far = Array.from({ length: 50 }, (_, i) => voter(1 + i * 1e-5, [71]));
		expect(nearbyVote(at, [...near, ...far])).toBe(72);
	});

	// Where turf is sparse, a city an hour away must not outvote the
	// neighbours there are.
	it('counts only turf within the radius', () => {
		const neighbours = [voter(0.01, [71]), voter(0.02, [71])];
		const city = Array.from({ length: 10 }, (_, i) => voter(0.6 + i * 1e-4, [72]));
		expect(nearbyVote(at, [...neighbours, ...city])).toBe(71);
	});

	it('takes the nearest when nothing is within the radius', () => {
		expect(nearbyVote(at, [voter(1, [72]), voter(2, [71]), voter(2.1, [71])])).toBe(72);
	});

	it('has nothing to say with no voters', () => {
		expect(nearbyVote(at, [])).toBeNull();
	});
});

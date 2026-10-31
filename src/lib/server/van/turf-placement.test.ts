import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, isNull } from 'drizzle-orm';
import { vanTurfs } from '../schema.js';
import { acquireSyncLock, releaseSyncLock } from '../sync-lock.js';
import { vanPlacementLock } from './locks.js';
import { visibleToAnyChapter, visibleToChapter } from './chapter-visibility.js';
import {
	NEARBY_TURF_VOTES,
	MISS_RETRY_MS,
	PLACEMENT_CONCURRENCY,
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
/** Long enough ago that a miss then is tried again now. */
const HOURS_AGO = new Date(Date.now() - 3 * 60 * 60 * 1000);
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

	// So /turfs/organizer can tell "no chapter fits" from "not tried yet".
	it('remembers a turf nothing could place, until it moves', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await turf(501, REQUESTED, DETROIT);
		const result = await placeRequestedTurf(db, CAMPAIGN, {
			chapters: [],
			fetchFn: census('48104'),
			turfIds: [500],
		});
		expect(result).toMatchObject({ unplaced: 1 });
		const missed = async () =>
			Object.fromEntries((await loadRequestedTurf(db)).turfs.map((t) => [t.turfId, t.missed]));
		expect(await missed()).toEqual({ 500: true, 501: false });

		await client.execute('UPDATE van_turfs SET centroid_lat = 42.3 WHERE turf_id = 500');
		expect(await missed()).toEqual({ 500: false, 501: false });
	});

	it('forgets the miss once the turf is placed', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await placeRequestedTurf(db, CAMPAIGN, {
			chapters: [],
			fetchFn: census('48104'),
			now: HOURS_AGO,
		});
		await zipChapter('48104', 71);
		await place(census('48104'));
		const [row] = (await loadRequestedTurf(db)).turfs;
		expect(row).toMatchObject({ missed: false, placement: { source: 'zip' } });
		const { rows } = await client.execute('SELECT count(*) AS n FROM van_turf_placement_misses');
		expect(rows[0]!.n).toBe(0);
	});

	// A run that cannot reach them all must not spend itself on the same
	// misses each time while new turf waits.
	it('tries turf never tried before the misses', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await placeRequestedTurf(db, CAMPAIGN, {
			chapters: [],
			fetchFn: census(null),
			now: HOURS_AGO,
		});
		await turf(501, REQUESTED, DETROIT);
		const asked: string[] = [];
		const fetchFn = vi.fn(async (url: string) => {
			asked.push(new URL(url).searchParams.get('geometry')!);
			return Response.json({ features: [] });
		}) as unknown as typeof fetch;
		await placeRequestedTurf(db, CAMPAIGN, { chapters: [], fetchFn });
		expect(asked).toEqual([`${DETROIT.lng},${DETROIT.lat}`, `${ANN_ARBOR.lng},${ANN_ARBOR.lat}`]);
	});

	// Every try is a Census lookup, and the answer seldom changes.
	it('leaves a recent miss alone unless the turf moved or an organizer asks', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		const opts = { chapters: [], fetchFn: census('48104') };
		await placeRequestedTurf(db, CAMPAIGN, opts);
		const again = census('48104');
		await placeRequestedTurf(db, CAMPAIGN, { ...opts, fetchFn: again });
		expect(again).not.toHaveBeenCalled();

		await placeRequestedTurf(db, CAMPAIGN, { ...opts, fetchFn: again, turfIds: [500] });
		expect(again).toHaveBeenCalledOnce();

		await client.execute('UPDATE van_turfs SET centroid_lat = 42.3 WHERE turf_id = 500');
		await placeRequestedTurf(db, CAMPAIGN, { ...opts, fetchFn: again });
		expect(again).toHaveBeenCalledTimes(2);

		const later = census('48104');
		await placeRequestedTurf(db, CAMPAIGN, {
			...opts,
			fetchFn: later,
			now: new Date(Date.now() + MISS_RETRY_MS + 1000),
		});
		expect(later).toHaveBeenCalledOnce();
	});

	// An organizer who fixed what kept a turf out presses "Sync VAN now".
	it('tries recent misses again when asked to', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await placeRequestedTurf(db, CAMPAIGN, { chapters: [], fetchFn: census('48104') });
		await zipChapter('48104', 71);
		const result = await placeRequestedTurf(db, CAMPAIGN, {
			chapters: CHAPTERS,
			fetchFn: census('48104'),
			retryMisses: true,
		});
		expect(result).toMatchObject({ byZip: 1 });
	});

	it('forgets the misses of turf that left the folder or was retired', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await turf(501, REQUESTED, ANN_ARBOR);
		await turf(502, REQUESTED, ANN_ARBOR);
		await placeRequestedTurf(db, CAMPAIGN, { chapters: [], fetchFn: census('48104') });
		await client.execute('UPDATE van_turfs SET folder_id = 10 WHERE turf_id = 500');
		await client.execute(`UPDATE van_turfs SET retired_at = '${AT}' WHERE turf_id = 501`);
		await placeRequestedTurf(db, CAMPAIGN, { chapters: [], fetchFn: census('48104') });
		const { rows } = await client.execute('SELECT turf_id FROM van_turf_placement_misses');
		expect(rows.map((r) => r.turf_id)).toEqual([502]);
	});

	// The ZIP was never asked, so "no chapter fits" would not be known.
	it('records no miss when the Census does not answer', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		const result = await placeRequestedTurf(db, CAMPAIGN, {
			chapters: [],
			fetchFn: census('down'),
		});
		expect(result).toMatchObject({ unplaced: 1 });
		expect((await loadRequestedTurf(db)).turfs[0]).toMatchObject({ missed: false });
	});

	it('records no miss over a placement made meanwhile', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		const fetchFn = vi.fn(async () => {
			await setOrganizerPlacement(db, 500, CHAPTERS[1]!, 'Alex');
			return Response.json({ features: [] });
		}) as unknown as typeof fetch;
		await placeRequestedTurf(db, CAMPAIGN, { chapters: [], fetchFn });
		const { rows } = await client.execute('SELECT count(*) AS n FROM van_turf_placement_misses');
		expect(rows[0]!.n).toBe(0);
	});

	// A failed run must not go on writing after its caller has been told so.
	it('stops taking turf once one fails, and throws', async () => {
		for (let i = 0; i < 20; i++) await turf(500 + i, REQUESTED, ANN_ARBOR);
		let calls = 0;
		const fetchFn = vi.fn(async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 5));
			return Response.json({ features: [] });
		}) as unknown as typeof fetch;
		// Every lookup answers; writing the miss fails.
		vi.spyOn(db, 'run').mockRejectedValue(new Error('db down'));
		await expect(placeRequestedTurf(db, CAMPAIGN, { chapters: [], fetchFn })).rejects.toThrow(
			'db down',
		);
		// The first few, in flight together; none took another after.
		expect(calls).toBe(PLACEMENT_CONCURRENCY);
	});

	// The staggered cron runs, the press and the webhook must not all look up
	// the same turf at once.
	it('leaves the turf to another run placing the same campaign', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 71);
		const held = await acquireSyncLock(db, vanPlacementLock(1), 60_000);
		const fetchFn = census('48104');
		const result = await place(fetchFn);
		expect(result).toMatchObject({ busy: true, byZip: 0 });
		expect(fetchFn).not.toHaveBeenCalled();

		// An organizer's own turf does not wait for it.
		expect(await place(fetchFn, [500])).toMatchObject({ byZip: 1 });

		await releaseSyncLock(db, vanPlacementLock(1), held!);
		await turf(501, REQUESTED, ANN_ARBOR);
		expect(await place(fetchFn)).toMatchObject({ byZip: 1 });
		// And lets it go.
		expect(await acquireSyncLock(db, vanPlacementLock(1), 1000)).not.toBeNull();
	});

	it('stops taking turf when asked to', async () => {
		for (let i = 0; i < 20; i++) await turf(500 + i, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 71);
		const realNow = Date.now;
		let calls = 0;
		const fetchFn = vi.fn(async () => {
			// The check is due from the second turf on.
			if (++calls === 1) vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10_000);
			return Response.json({ features: [{ attributes: { ZCTA5: '48104' } }] });
		}) as unknown as typeof fetch;
		const result = await placeRequestedTurf(db, CAMPAIGN, {
			chapters: CHAPTERS,
			fetchFn,
			timeBudgetMs: 60_000,
			shouldStop: async () => true,
		});
		expect(result.stopped).toBe(true);
		expect(result.byZip).toBeLessThan(20);
	});

	it('looks up several turfs at once', async () => {
		for (let i = 0; i < 12; i++) await turf(500 + i, REQUESTED, ANN_ARBOR);
		await zipChapter('48104', 71);
		let inFlight = 0;
		let most = 0;
		const fetchFn = vi.fn(async () => {
			most = Math.max(most, ++inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return Response.json({ features: [{ attributes: { ZCTA5: '48104' } }] });
		}) as unknown as typeof fetch;
		const result = await place(fetchFn);
		expect(result).toMatchObject({ byZip: 12 });
		expect(most).toBe(PLACEMENT_CONCURRENCY);
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

	// Each of these used to read "waiting for its shape" for as long as it
	// stayed in the folder.
	it('says why turf with no location has none', async () => {
		for (const id of [500, 501, 502, 503, 504]) await turf(id, REQUESTED, null);
		// 500: nobody in it. The rest have people and a list.
		await client.execute(
			'UPDATE van_turfs SET saved_list_id = 1, route_size = 40 WHERE turf_id IN (501, 502, 503, 504)',
		);
		const queue = (id: number, status: string, error: string | null) =>
			client.execute({
				sql: 'INSERT INTO van_geometry_queue (turf_id, saved_list_id, status, attempts, last_error) VALUES (?, 1, ?, 4, ?)',
				args: [id, status, error],
			});
		await queue(501, 'pending', null);
		await queue(502, 'failed', 'export job errored');
		await queue(503, 'done', null);
		// 504: not queued yet.
		const { turfs } = await loadRequestedTurf(db);
		const shape = Object.fromEntries(turfs.map((t) => [t.turfId, [t.shape, t.shapeError]]));
		expect(shape).toEqual({
			500: ['empty', null],
			501: ['waiting', null],
			502: ['failed', 'export job errored'],
			503: ['unmapped', null],
			504: ['waiting', null],
		});
	});

	it('says whether it can be claimed, never with which number', async () => {
		await turf(500, REQUESTED, ANN_ARBOR);
		await turf(501, REQUESTED, ANN_ARBOR);
		await client.execute(
			`UPDATE van_turfs SET printed_list_number = 'L123', hidden_at = '${AT}' WHERE turf_id = 501`,
		);
		const { turfs } = await loadRequestedTurf(db);
		const row = Object.fromEntries(turfs.map((t) => [t.turfId, t]));
		expect(row[500]).toMatchObject({ claimable: false, hidden: false, shape: null });
		expect(row[501]).toMatchObject({ claimable: true, hidden: true });
		expect(JSON.stringify(turfs)).not.toContain('L123');
	});

	it('lists the newest first among the unplaced, and only new turf when asked', async () => {
		await turf(500, REQUESTED, null);
		await turf(501, REQUESTED, null);
		await turf(502, REQUESTED, null);
		await client.execute(
			"UPDATE van_turfs SET first_seen_at = '2026-10-23T10:00:00.000Z' WHERE turf_id = 501",
		);
		await client.execute(
			"UPDATE van_turfs SET first_seen_at = '2026-10-23T11:00:00.000Z' WHERE turf_id = 502",
		);
		expect((await loadRequestedTurf(db)).turfs.map((t) => t.turfId)).toEqual([502, 501, 500]);

		const since = await loadRequestedTurf(db, 300, { firstSeenSince: '2026-10-23T10:30:00.000Z' });
		expect(since.turfs.map((t) => t.turfId)).toEqual([502]);
		expect(since.total).toBe(1);
	});

	// A route moved into the folder keeps the firstSeenAt it had, so what a
	// press picked up is what was not there when it was pressed.
	it('leaves out the turf a press found already in the folder', async () => {
		await turf(500, REQUESTED, null);
		await turf(501, REQUESTED, null);
		const found = await loadRequestedTurf(db, 300, { excludeTurfIds: [500] });
		expect(found.turfs.map((t) => t.turfId)).toEqual([501]);
		expect(found.total).toBe(1);
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

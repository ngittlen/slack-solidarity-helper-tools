import { describe, afterEach, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { runCatalogSync } from './sync.js';
import { recomputeUncontacted, upsertContacts } from './contact-sync.js';
import type { VanClient } from './client.js';
import type { VanMapRegion, VanMapRoute } from './types.js';

// Two VAN campaigns whose ids collide (specs/012-multi-van-campaigns).
//
// Folder, region and route ids are VAN's and unique only within one committee.
// Both campaigns here are given the SAME folder 2731, region 10 and routes
// 56456/56457, which is the worst case the schema has to survive: each
// campaign's catalog, retirements, geometry and door counts must stay its own.
//
// Real SQLite, because what is under test is how rows are keyed and matched —
// a fake would only show which statements were built.

let db: ReturnType<typeof drizzle>;
let client: Client;

const A = 1;
const B = 2;
const FOLDER = 2731;
const MAPPINGS = [{ chapterId: 71, chapterName: 'Washtenaw County', folderIds: [FOLDER] }];

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await client.execute(
		`INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (${B}, 'other', 1, 's', 's', '2026-09-30T00:00:00.000Z')`,
	);
});

afterEach(() => {
	client.close();
});

function route(mapRouteId: number, name: string, savedListId: number): VanMapRoute {
	return {
		mapRouteId,
		name,
		savedListId,
		routeNumber: 1,
		routeSize: 50,
		doorCount: 40,
		phoneCount: 0,
		printedList: { number: `list-${savedListId}` },
	} as VanMapRoute;
}

/** A VAN key that sees one folder holding the given routes. */
function vanWith(routes: VanMapRoute[]): VanClient {
	const regions: VanMapRegion[] = [
		{ mapRegionId: 10, name: 'Ann Arbor', dateRefreshed: null, mapRoutes: routes },
	] as VanMapRegion[];
	return {
		folders: async () => [{ folderId: FOLDER, name: 'Turf' }],
		mapRegions: async () => regions,
		printedLists: async () => [],
		savedLists: async () => [],
		minivanExportsSince: async () => ({ items: [], complete: true }),
		refreshMapRegion: async () => undefined,
		exportJobTypes: async () => [],
		createExportJob: async () => ({}) as never,
		exportJob: async () => ({}) as never,
		createChangedEntityExportJob: async () => ({}) as never,
		changedEntityExportJob: async () => ({}) as never,
		contactTypes: async () => [],
		changeTypes: async () => [],
		get: async () => undefined as never,
	};
}

interface TurfRow {
	turf_id: number;
	campaign_id: number;
	van_map_route_id: number;
	name: string;
	saved_list_id: number;
	retired_at: string | null;
}

async function turfs(campaignId: number): Promise<TurfRow[]> {
	const res = await client.execute({
		sql: `SELECT turf_id, campaign_id, van_map_route_id, name, saved_list_id, retired_at
		      FROM van_turfs WHERE campaign_id = ? ORDER BY van_map_route_id`,
		args: [campaignId],
	});
	return res.rows as unknown as TurfRow[];
}

const A_ROUTES = [route(56456, 'A Turf 01', 900), route(56457, 'A Turf 02', 901)];
const B_ROUTES = [route(56456, 'B Turf 01', 700), route(56457, 'B Turf 02', 701)];

describe('two campaigns with identical VAN ids', () => {
	it('keeps the first campaign’s turf on its VAN ids, and gives the second its own', async () => {
		await runCatalogSync(db, vanWith(A_ROUTES), A, MAPPINGS);
		await runCatalogSync(db, vanWith(B_ROUTES), B, MAPPINGS);

		const a = await turfs(A);
		const b = await turfs(B);
		// A synced first, so its turf took VAN's ids as its own.
		expect(a.map((t) => [t.turf_id, t.van_map_route_id, t.name])).toEqual([
			[56456, 56456, 'A Turf 01'],
			[56457, 56457, 'A Turf 02'],
		]);
		// B's turf carries the same VAN ids, but those turf ids were taken.
		expect(b.map((t) => [t.van_map_route_id, t.name])).toEqual([
			[56456, 'B Turf 01'],
			[56457, 'B Turf 02'],
		]);
		const bIds = b.map((t) => t.turf_id);
		expect(new Set([...bIds, 56456, 56457]).size).toBe(4);
	});

	// The bug this whole design exists to prevent: B's sync looked at folder
	// 2731, saw none of A's routes, and retired them.
	it('never retires, overwrites or re-keys the other campaign’s turf', async () => {
		await runCatalogSync(db, vanWith(A_ROUTES), A, MAPPINGS);
		const before = await turfs(A);

		// B's folder 2731 is the same id with completely different turf in it.
		await runCatalogSync(db, vanWith([route(99999, 'B only', 800)]), B, MAPPINGS);
		await runCatalogSync(db, vanWith(B_ROUTES), B, MAPPINGS);

		expect(await turfs(A)).toEqual(before);
	});

	it('retires only within the campaign whose VAN stopped returning the route', async () => {
		await runCatalogSync(db, vanWith(A_ROUTES), A, MAPPINGS);
		await runCatalogSync(db, vanWith(B_ROUTES), B, MAPPINGS);

		// B's Turf 02 is gone from B's VAN; A still has a Turf 02 on the same id.
		await runCatalogSync(db, vanWith([B_ROUTES[0]!]), B, MAPPINGS);

		expect((await turfs(B)).map((t) => [t.name, t.retired_at !== null])).toEqual([
			['B Turf 01', false],
			['B Turf 02', true],
		]);
		expect((await turfs(A)).every((t) => t.retired_at === null)).toBe(true);
	});

	it('updates its own turf in place on a later sync, keeping the turf id', async () => {
		await runCatalogSync(db, vanWith(A_ROUTES), A, MAPPINGS);
		await runCatalogSync(db, vanWith(B_ROUTES), B, MAPPINGS);
		const bIds = (await turfs(B)).map((t) => t.turf_id);

		await runCatalogSync(
			db,
			vanWith([route(56456, 'B Turf 01 renamed', 700), B_ROUTES[1]!]),
			B,
			MAPPINGS,
		);

		const b = await turfs(B);
		expect(b.map((t) => t.turf_id)).toEqual(bIds);
		expect(b[0]!.name).toBe('B Turf 01 renamed');
		expect((await turfs(A))[0]!.name).toBe('A Turf 01');
	});

	// VAN hands out route ids in sequence, so the id the database would give a
	// colliding turf (one past the highest in use) is very likely the VAN id of
	// the next new route — in the same batch. Both must still land.
	it('assigns a colliding turf an id no other new turf in the same sync wants', async () => {
		await runCatalogSync(db, vanWith(A_ROUTES), A, MAPPINGS);
		// 56456 collides with A's; 56458 is new and free, and is max + 1.
		await runCatalogSync(
			db,
			vanWith([route(56456, 'B Turf 01', 700), route(56458, 'B Turf 03', 702)]),
			B,
			MAPPINGS,
		);

		const b = await turfs(B);
		expect(b.map((t) => [t.van_map_route_id, t.name])).toEqual([
			[56456, 'B Turf 01'],
			[56458, 'B Turf 03'],
		]);
		// The free one keeps VAN's id; the colliding one gets one nobody uses.
		expect(b[1]!.turf_id).toBe(56458);
		expect([56456, 56457, 56458]).not.toContain(b[0]!.turf_id);
	});

	it('queues geometry for a colliding new turf under its own turf id', async () => {
		await runCatalogSync(db, vanWith(A_ROUTES), A, MAPPINGS);
		await runCatalogSync(db, vanWith(B_ROUTES), B, MAPPINGS);

		const res = await client.execute(
			'SELECT q.turf_id, q.saved_list_id, t.campaign_id FROM van_geometry_queue q JOIN van_turfs t ON t.turf_id = q.turf_id ORDER BY q.saved_list_id',
		);
		expect(res.rows.map((r) => [r.campaign_id, r.saved_list_id])).toEqual([
			[B, 700],
			[B, 701],
			[A, 900],
			[A, 901],
		]);
		const bIds = new Set((await turfs(B)).map((t) => t.turf_id));
		const queuedForB = res.rows.filter((r) => r.campaign_id === B).map((r) => r.turf_id);
		expect(queuedForB.every((id) => bIds.has(id as number))).toBe(true);
	});

	it('records each campaign’s sync state separately', async () => {
		await runCatalogSync(db, vanWith(A_ROUTES), A, MAPPINGS);
		await runCatalogSync(db, vanWith(B_ROUTES), B, MAPPINGS);
		const res = await client.execute('SELECT campaign_id FROM van_sync_state ORDER BY campaign_id');
		expect(res.rows.map((r) => r.campaign_id)).toEqual([A, B]);
	});
});

describe('door counts across campaigns', () => {
	// Turf 1 (campaign A) and turf 2 (campaign B) have the same one person on
	// their rosters — same voter, two committees canvassing the same street.
	beforeEach(async () => {
		const at = '2026-09-01T00:00:00.000Z';
		await client.executeMultiple(`
			INSERT INTO van_turfs (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id, name, saved_list_id, roster_saved_list_id, cut_at, first_seen_at, last_seen_at)
			VALUES (1, ${A}, 1, 10, ${FOLDER}, 71, 'A', 5, 5, '${at}', '${at}', '${at}'),
			       (2, ${B}, 1, 10, ${FOLDER}, 71, 'B', 5, 5, '${at}', '${at}', '${at}');
			INSERT INTO van_turf_roster (turf_id, person_hash, door_hash) VALUES (1, x'01', x'0a'), (2, x'01', x'0a');
		`);
	});

	const uncontacted = async (turfId: number) =>
		(await client.execute(`SELECT uncontacted_doors FROM van_turfs WHERE turf_id = ${turfId}`))
			.rows[0]!.uncontacted_doors;

	// Campaign B's key cannot see campaign A's ContactHistory, and B's
	// canvassers knocking does not take a door off A's list in A's MiniVAN.
	it('counts a door contacted only against the campaign whose contact it is', async () => {
		const now = new Date('2026-09-30T00:00:00.000Z');
		await upsertContacts(
			db,
			B,
			new Map([['01', { personHash: Buffer.from([1]), at: '2026-09-15T00:00:00.000Z' }]]),
		);
		await recomputeUncontacted(db, { now, campaignId: A });
		await recomputeUncontacted(db, { now, campaignId: B });

		expect(await uncontacted(1)).toBe(1);
		expect(await uncontacted(2)).toBe(0);
	});

	it('recomputes only the campaign it is run for', async () => {
		const now = new Date('2026-09-30T00:00:00.000Z');
		await recomputeUncontacted(db, { now, campaignId: B });
		expect(await uncontacted(1)).toBeNull();
		expect(await uncontacted(2)).toBe(1);
	});
});

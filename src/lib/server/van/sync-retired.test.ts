// runCatalogSync against a real (in-memory) database, for the reads that
// sync.test.ts's stub cannot check: it answers every select with every row,
// whatever the where clause. Retired turf is loaded in part — slim for the
// sweeps, whole only for a route VAN lists again — and that split is what
// these cover.

import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { runCatalogSync } from './sync.js';
import type { VanClient } from './client.js';
import type { VanMapRegion } from './types.js';

let db: ReturnType<typeof drizzle>;
let client: Client;
const AT = '2026-09-20T00:00:00.000Z';
const HULL = '[{"lat":42,"lng":-83},{"lat":42.1,"lng":-83},{"lat":42.1,"lng":-83.1}]';
const MAPPING = [{ chapterId: 71, chapterName: 'Middlesex County', folderIds: [1152] }];

async function insert(table: string, row: Record<string, string | number | null>): Promise<void> {
	const cols = Object.keys(row).join(', ');
	const vals = Object.values(row)
		.map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`))
		.join(', ');
	await client.execute(`INSERT INTO ${table} (${cols}) VALUES (${vals})`);
}

async function turf(
	turfId: number,
	over: Record<string, string | number | null> = {},
): Promise<void> {
	await insert('van_turfs', {
		turf_id: turfId,
		van_map_route_id: turfId,
		map_region_id: 10,
		folder_id: 1152,
		chapter_id: 71,
		chapter_name: 'Middlesex County',
		region_name: 'Cambridge North',
		name: `Turf ${turfId}`,
		saved_list_id: 900,
		door_count: 250,
		route_size: 400,
		hull_json: null,
		retired_at: null,
		first_seen_at: AT,
		last_seen_at: AT,
		...over,
	});
}

/** VAN with one region holding the given routes. */
function vanListing(routeIds: number[]): VanClient {
	const region = {
		mapRegionId: 10,
		name: 'Cambridge North',
		mapRoutes: routeIds.map((id) => ({
			mapRouteId: id,
			name: `Turf ${id}`,
			savedListId: 900,
			routeNumber: 1,
			routeSize: 400,
			doorCount: 250,
			phoneCount: 0,
			printedList: { number: `35536745-${id}` },
		})),
	} as VanMapRegion;
	return {
		folders: async () => [{ folderId: 1152, name: 'Middlesex Turf' }],
		mapRegions: async () => [region],
		printedLists: async () => [],
		minivanExportsSince: async () => ({ items: [], complete: true }),
	} as unknown as VanClient;
}

async function turfRow(turfId: number) {
	const { rows } = await client.execute({
		sql: 'SELECT retired_at, hull_json FROM van_turfs WHERE turf_id = ?',
		args: [turfId],
	});
	return rows[0];
}

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

describe('runCatalogSync with retired turf', () => {
	it('unretires a route VAN lists again, keeping its shape', async () => {
		await turf(100, {
			retired_at: '2026-09-21T00:00:00.000Z',
			hull_json: HULL,
			hull_source_route_size: 400,
		});

		const result = await runCatalogSync(db, vanListing([100]), 1, MAPPING);

		expect(result.turfsUnretired).toBe(1);
		expect(result.turfsRetired).toBe(0);
		// The whole row was read: an unretirement planned without it would
		// write the hull as null and queue the turf to be drawn again.
		expect(await turfRow(100)).toMatchObject({ retired_at: null, hull_json: HULL });
	});

	it('leaves retired turf VAN does not list retired, and sweeps its queued geometry', async () => {
		await turf(100);
		await turf(200, { retired_at: '2026-09-21T00:00:00.000Z' });
		await insert('van_geometry_queue', {
			turf_id: 200,
			saved_list_id: 900,
			status: 'failed',
			attempts: 4,
		});

		const result = await runCatalogSync(db, vanListing([100]), 1, MAPPING);

		expect(result.turfsUnretired).toBe(0);
		expect(result.geometryQueueDropped).toBe(1);
		expect(await turfRow(200)).toMatchObject({ retired_at: '2026-09-21T00:00:00.000Z' });
	});
});

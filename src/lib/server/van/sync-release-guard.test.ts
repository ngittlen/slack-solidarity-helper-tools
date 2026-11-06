import { describe, afterEach, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq, sql } from 'drizzle-orm';
import { vanTurfs } from '../schema.js';
import { unlessReleased } from './sync.js';

// A real in-memory libsql: the guard is a CASE over the stored row, in the
// catalog upsert's DO UPDATE and in the held-turf update.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const RELEASED = '2026-10-01T12:00:00.000Z';

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (turf_id, van_map_route_id, map_region_id, folder_id, chapter_id, chapter_name,
		         region_name, name, door_count, first_seen_at, last_seen_at, van_released_at)
		      VALUES (100, 100, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 100', 250, 'x', 'x', ?)`,
		args: [RELEASED],
	});
});

afterEach(() => client.close());

const write = (vanDistributedTo: string | null, vanAssignedAt: string | null) =>
	db
		.update(vanTurfs)
		.set(unlessReleased(sql`${vanDistributedTo}`, sql`${vanAssignedAt}`))
		.where(eq(vanTurfs.turfId, 100));

const stored = async () =>
	(
		await db
			.select({ to: vanTurfs.vanDistributedTo, at: vanTurfs.vanAssignedAt })
			.from(vanTurfs)
			.where(eq(vanTurfs.turfId, 100))
	)[0];

describe('unlessReleased', () => {
	it('writes no hand-out from at or before the release', async () => {
		await write('Sam Ito', RELEASED);
		expect(await stored()).toEqual({ to: null, at: null });
		await write('Sam Ito', '2026-09-30T12:00:00.000Z');
		expect(await stored()).toEqual({ to: null, at: null });
		await write('Sam Ito', null);
		expect(await stored()).toEqual({ to: null, at: null });
	});

	it('writes a hand-out from after the release', async () => {
		await write('Dana Ruiz', '2026-10-02T09:00:00.000Z');
		expect(await stored()).toEqual({ to: 'Dana Ruiz', at: '2026-10-02T09:00:00.000Z' });
	});

	it('writes any hand-out on turf never released', async () => {
		await client.execute('UPDATE van_turfs SET van_released_at = NULL');
		await write('Sam Ito', '2026-09-30T12:00:00.000Z');
		expect(await stored()).toEqual({ to: 'Sam Ito', at: '2026-09-30T12:00:00.000Z' });
	});

	it('guards the catalog upsert’s DO UPDATE', async () => {
		await db
			.insert(vanTurfs)
			.values({
				turfId: 100,
				campaignId: 1,
				vanMapRouteId: 100,
				mapRegionId: 1,
				folderId: 1,
				chapterId: 71,
				chapterName: 'Washtenaw County',
				regionName: 'Ann Arbor',
				name: 'Turf 100',
				doorCount: 250,
				firstSeenAt: 'x',
				lastSeenAt: 'x',
				vanDistributedTo: 'Sam Ito',
				vanAssignedAt: RELEASED,
			})
			.onConflictDoUpdate({
				target: [vanTurfs.campaignId, vanTurfs.vanMapRouteId],
				set: {
					doorCount: 240,
					...unlessReleased(sql`excluded.van_distributed_to`, sql`excluded.van_assigned_at`),
				},
			});
		expect(await stored()).toEqual({ to: null, at: null });
	});
});

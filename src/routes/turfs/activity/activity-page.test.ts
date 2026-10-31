import { describe, afterEach, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { loadActivityPage } from './activity-page.js';
import { rangeFor, type ActivityCursor } from '$lib/van/turf-activity.js';

// Paging against a real in-memory libsql, as activity-store.test.ts does: what
// matters is that walking the pages by cursor hands back every event exactly
// once and in order, and only the engine's own ordering can show that.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-08-24T18:00:00.000Z');
const query = { chapterId: null, range: rangeFor('7', NOW) };

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await client.execute({
		sql: `INSERT INTO van_turfs (turf_id, van_map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name, name, door_count, first_seen_at, last_seen_at)
		      VALUES (100, 100, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 01', 250, ?, ?),
		             (200, 200, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 02', 180, ?, ?),
		             (300, 300, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 03', 90, ?, ?),
		             (400, 400, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 04', 200, ?, ?),
		             (500, 500, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', 'Turf 05', 210, ?, ?)`,
		args: Array.from({ length: 10 }, () => NOW.toISOString()),
	});
});

afterEach(() => {
	client.close();
});

async function checkout(turfId: number, claimedAt: string, end?: Record<string, string>) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at, released_at, completed_at, release_reason)
		      VALUES (?, 'U_VOL', 'Dana', ?, '2026-08-30T00:00:00.000Z', ?, ?, ?)`,
		args: [turfId, claimedAt, end?.released ?? null, end?.completed ?? null, end?.reason ?? null],
	});
}

/** Every page in turn, as the browser asks for them. */
async function walk(pageSize: number): Promise<string[]> {
	const shown: string[] = [];
	let after: ActivityCursor | null = null;
	for (let guard = 0; guard < 50; guard++) {
		const page = await loadActivityPage(db, query, NOW, { after, pageSize });
		shown.push(...page.events.map((event) => event.id));
		if (!page.hasMore) return shown;
		after = page.events.at(-1)!;
	}
	throw new Error('paging did not finish');
}

describe('loadActivityPage', () => {
	beforeEach(async () => {
		await checkout(100, '2026-08-24T08:00:00.000Z', { completed: '2026-08-24T15:00:00.000Z' });
		await checkout(200, '2026-08-24T09:00:00.000Z', {
			released: '2026-08-24T12:00:00.000Z',
			reason: 'volunteer',
		});
		await checkout(300, '2026-08-24T13:00:00.000Z');
		// Three events in one millisecond, so some page boundary splits them.
		await checkout(400, '2026-08-24T10:00:00.000Z');
		await checkout(500, '2026-08-24T10:00:00.000Z');
		await checkout(100, '2026-08-23T07:00:00.000Z', {
			released: '2026-08-24T10:00:00.000Z',
			reason: 'expired',
		});
	});

	it('walks every event once, in order, whatever the page size', async () => {
		const everything = (await loadActivityPage(db, query, NOW, { pageSize: 100 })).events.map(
			(event) => event.id,
		);
		expect(everything).toEqual([
			'1:completed',
			'3:claimed',
			'2:given-back',
			'6:expired',
			'5:claimed',
			'4:claimed',
			'2:claimed',
			'1:claimed',
			'6:claimed',
		]);
		for (const size of [1, 2, 3, 4, 5]) {
			expect(await walk(size)).toEqual(everything);
		}
	});

	it('says whether another page exists', async () => {
		expect((await loadActivityPage(db, query, NOW, { pageSize: 8 })).hasMore).toBe(true);
		expect((await loadActivityPage(db, query, NOW, { pageSize: 9 })).hasMore).toBe(false);
	});

	it('labels later pages against the first page’s now', async () => {
		const page = await loadActivityPage(db, query, NOW, {
			after: { at: '2026-08-24T12:00:00.000Z', checkoutId: 2, id: '2:given-back' },
			pageSize: 1,
		});
		expect(page.events[0]).toMatchObject({ id: '6:expired', agoLabel: '8h ago' });
		expect(page.dayLabels['2026-08-24']).toBeTruthy();
	});
});

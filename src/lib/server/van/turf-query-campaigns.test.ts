import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { loadChapterTurfs } from './turf-query.js';

// A disabled campaign's turf leaves the map and /turfs
// (specs/012-multi-van-campaigns), except turf the viewer is still walking.
// On a real in-memory database, because the filter is SQL: the scripted db in
// turf-query.test.ts would answer the same whatever the WHERE said.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const VIEWER = { slackUserId: 'U_VOL', isAdmin: false };
const NOW = new Date('2026-10-01T18:00:00.000Z');

async function campaign(id: number, enabled: boolean) {
	await client.execute({
		sql: `INSERT INTO van_campaigns
		        (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
		      VALUES (?, ?, ?, 'test', 'test', 'x')
		      ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled`,
		args: [id, `campaign${id}`, enabled ? 1 : 0],
	});
	// Chapter 71 sees folder 1 in every campaign.
	await client.execute({
		sql: `INSERT INTO van_chapter_folders
		        (campaign_id, chapter_id, folder_id, chapter_name,
		         last_edited_by, last_edited_by_name, last_edited_at)
		      VALUES (?, 71, 1, 'Wayne County', 'test', 'test', 'x')`,
		args: [id],
	});
}

async function turf(turfId: number, campaignId: number) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id,
		         chapter_name, region_name, name, printed_list_number, route_size, door_count,
		         first_seen_at, last_seen_at)
		      VALUES (?1, ?2, ?1, 1, 1, 71, 'Wayne County', 'R10C_Wayne', ?3, '1-1', 120, 50,
		              'x', 'x')`,
		args: [turfId, campaignId, `Turf ${turfId}`],
	});
}

async function claim(turfId: number) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at)
		      VALUES (?, 'U_VOL', 'Dana', '2026-10-01T12:00:00.000Z', '2026-10-03T12:00:00.000Z')`,
		args: [turfId],
	});
}

const idsOf = (r: { turfs: Array<{ turfId: number }> }) => r.turfs.map((t) => t.turfId).sort();

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await campaign(1, true);
	await campaign(2, false);
	await turf(100, 1);
	await turf(200, 2);
	await turf(201, 2);
});

describe('a disabled campaign’s turf', () => {
	it('is not offered', async () => {
		const result = await loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER, now: NOW });
		expect(idsOf(result)).toEqual([100]);
	});

	// Disabling stops new claims, not the ones in progress: a volunteer halfway
	// down a street still needs the turf on their map.
	it('stays visible to the volunteer holding it', async () => {
		await claim(201);
		const result = await loadChapterTurfs(db, {
			chapterId: 71,
			viewer: VIEWER,
			now: NOW,
			includeHeldByViewer: true,
		});
		expect(idsOf(result)).toEqual([100, 201]);
	});

	it('comes back when the campaign is enabled again', async () => {
		await client.execute('UPDATE van_campaigns SET enabled = 1 WHERE id = 2');
		const result = await loadChapterTurfs(db, { chapterId: 71, viewer: VIEWER, now: NOW });
		expect(idsOf(result)).toEqual([100, 200, 201]);
	});
});

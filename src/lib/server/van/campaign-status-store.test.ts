import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { loadCampaignStatus, loadCampaignSummaries } from './campaign-status-store.js';

// What the settings pages say about a campaign. The numbers that matter most
// are the disable dialog's: how much turf disabling hides, and how many claims
// it lets run on — each counted for this campaign only.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-10-01T18:00:00.000Z');

async function turf(turfId: number, campaignId: number, retired = false) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id,
		         chapter_name, region_name, name, route_size, door_count, first_seen_at, last_seen_at,
		         retired_at)
		      VALUES (?1, ?2, ?1, 1, 1, 71, 'Wayne County', 'R', 'Turf', 120, 50, 'x', 'x', ?3)`,
		args: [turfId, campaignId, retired ? 'x' : null],
	});
}

async function claim(turfId: number, expiresAt = '2026-10-03T12:00:00.000Z') {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at)
		      VALUES (?, 'U1', 'Dana', '2026-10-01T12:00:00.000Z', ?)`,
		args: [turfId, expiresAt],
	});
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await client.execute(
		`INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (2, 'partner', 0, 'sync', 'sync', 'x')`,
	);
});

describe('loadCampaignStatus', () => {
	it('is all zeroes and nulls for a campaign that has never synced', async () => {
		expect(await loadCampaignStatus(db, 2, NOW)).toEqual({
			lastSyncAt: null,
			lastError: null,
			minivanExportsOk: null,
			liveTurfs: 0,
			retiredTurfs: 0,
			unclaimedLiveTurfs: 0,
			liveClaims: 0,
			geometryPending: 0,
			geometryFailed: 0,
			contactCursor: null,
			contactLastError: null,
			mappedFolders: 0,
		});
	});

	it('counts turf and claims for this campaign only', async () => {
		await turf(100, 1);
		await turf(101, 1);
		await turf(102, 1);
		await turf(103, 1, true);
		await turf(200, 2);
		await claim(100);
		// Past its expiry: over, even before the sweep stamps it.
		await claim(101, '2026-10-01T17:00:00.000Z');
		await claim(200);

		expect(await loadCampaignStatus(db, 1, NOW)).toMatchObject({
			liveTurfs: 3,
			retiredTurfs: 1,
			liveClaims: 1,
			unclaimedLiveTurfs: 2,
		});
		expect(await loadCampaignStatus(db, 2, NOW)).toMatchObject({
			liveTurfs: 1,
			liveClaims: 1,
			unclaimedLiveTurfs: 0,
		});
	});

	it('counts the shapes still to draw, and the ones that failed', async () => {
		await turf(100, 1);
		await turf(101, 1);
		await turf(102, 1);
		await turf(200, 2);
		for (const [turfId, status] of [
			[100, 'pending'],
			[101, 'running'],
			[102, 'failed'],
			[200, 'pending'],
		] as const) {
			await client.execute({
				sql: 'INSERT INTO van_geometry_queue (turf_id, saved_list_id, status) VALUES (?, 1, ?)',
				args: [turfId, status],
			});
		}
		expect(await loadCampaignStatus(db, 1, NOW)).toMatchObject({
			geometryPending: 2,
			geometryFailed: 1,
		});
	});

	it('counts the folders mapped for this campaign', async () => {
		for (const [campaignId, folderId] of [
			[1, 1],
			[1, 2],
			[2, 1],
		]) {
			await client.execute({
				sql: `INSERT INTO van_chapter_folders
				        (campaign_id, chapter_id, folder_id, chapter_name,
				         last_edited_by, last_edited_by_name, last_edited_at)
				      VALUES (?, 71, ?, 'Wayne County', 'test', 'test', 'x')`,
				args: [campaignId, folderId],
			});
		}
		expect((await loadCampaignStatus(db, 1, NOW)).mappedFolders).toBe(2);
		expect((await loadCampaignStatus(db, 2, NOW)).mappedFolders).toBe(1);
	});
});

describe('loadCampaignSummaries', () => {
	it('lists every campaign oldest first, with its live turf and last sync', async () => {
		await turf(100, 1);
		await turf(101, 1, true);
		await client.execute(
			`INSERT INTO van_sync_state (campaign_id, last_sync_at, last_error)
			 VALUES (2, '2026-10-01T17:30:00.000Z', 'VAN /folders returned 500')`,
		);

		const summaries = await loadCampaignSummaries(db);

		expect(summaries.map((s) => [s.campaign.id, s.liveTurfs, s.lastError])).toEqual([
			[1, 1, null],
			[2, 0, 'VAN /folders returned 500'],
		]);
	});
});

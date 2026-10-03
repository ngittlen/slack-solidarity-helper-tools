import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// Which spreadsheet each region routes to, one campaign at a time
// (specs/012-multi-van-campaigns): a campaign's rules never route another's
// checkouts, so the page shows one campaign's rules over its own turf.

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));

vi.mock('$lib/server/db.js', () => ({
	get db() {
		return holder.db;
	},
}));

import { load } from './+page.server.js';

let client: ReturnType<typeof createClient>;

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true };

type Data = {
	campaign: { id: number; name: string };
	trackerCampaigns: Array<{ id: number; name: string }>;
	groups: Array<{ spreadsheetId: string; regions: Array<{ regionName: string }> }>;
	unrouted: Array<{ regionName: string }>;
};

function run(query = '', session: unknown = ADMIN) {
	return load({
		locals: { session },
		url: new URL(`http://localhost/turfs/sheet-map${query}`),
	} as never) as Promise<Data>;
}

async function rule(campaignId: number, prefix: string, spreadsheetId: string) {
	await client.execute({
		sql: `INSERT INTO van_sheet_targets
		        (campaign_id, prefix_key, prefix, label, spreadsheet_id,
		         last_edited_by, last_edited_by_name, last_edited_at)
		      VALUES (?, ?, ?, ?, ?, 'test', 'test', 'x')`,
		args: [campaignId, prefix.toLowerCase(), prefix, prefix, spreadsheetId],
	});
}

async function turf(turfId: number, campaignId: number, regionName: string) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id,
		         chapter_name, region_name, name, route_size, door_count, first_seen_at, last_seen_at)
		      VALUES (?1, ?2, ?1, 1, 1, 71, 'Wayne County', ?3, 'Turf', 120, 50, 'x', 'x')`,
		args: [turfId, campaignId, regionName],
	});
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	holder.db = drizzle(client);
	await migrate(holder.db as ReturnType<typeof drizzle>, { migrationsFolder: 'drizzle' });
	await client.execute(`UPDATE van_campaigns SET label = 'One Team Michigan' WHERE id = 1`);
	await client.execute(
		`INSERT INTO van_campaigns
		   (id, credential_key, label, enabled, sheets_enabled,
		    last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (2, 'abdul', 'Partner', 1, 1, 'sync', 'sync', 'x')`,
	);
	await rule(1, 'R10C', 'sheet-primary');
	await rule(2, 'R10C', 'sheet-partner');
	await turf(100, 1, 'R10C_Wayne_Primary');
	await turf(200, 2, 'R10C_Wayne_Partner');
	await turf(201, 2, 'R99_Elsewhere');
});

describe('which campaign', () => {
	it('shows the primary campaign by default, with the others to switch to', async () => {
		const data = await run();
		expect(data.campaign).toMatchObject({ id: 1, name: 'One Team Michigan' });
		expect(data.trackerCampaigns.map((c) => c.id)).toEqual([1, 2]);
	});

	it('shows only that campaign’s rules over that campaign’s turf', async () => {
		const primary = await run();
		expect(primary.groups).toEqual([
			expect.objectContaining({
				spreadsheetId: 'sheet-primary',
				regions: [expect.objectContaining({ regionName: 'R10C_Wayne_Primary' })],
			}),
		]);
		expect(primary.unrouted).toEqual([]);

		const partner = await run('?campaign=2');
		expect(partner.groups).toEqual([
			expect.objectContaining({
				spreadsheetId: 'sheet-partner',
				regions: [expect.objectContaining({ regionName: 'R10C_Wayne_Partner' })],
			}),
		]);
		expect(partner.unrouted.map((r) => r.regionName)).toEqual(['R99_Elsewhere']);
	});

	it('404s for a campaign that does not exist, or a malformed id', async () => {
		await expect(run('?campaign=99')).rejects.toMatchObject({ status: 404 });
		await expect(run('?campaign=abc')).rejects.toMatchObject({ status: 404 });
	});

	it('redirects a non-admin', async () => {
		await expect(run('', { ...ADMIN, isAdmin: false })).rejects.toMatchObject({ status: 302 });
	});
});

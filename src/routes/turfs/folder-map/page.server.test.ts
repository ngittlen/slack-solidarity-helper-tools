import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// The folder map, one campaign at a time (specs/012-multi-van-campaigns): each
// campaign's folders are read with its own key, and its folder ids mean
// nothing to another campaign's key.

const { holder, mockClientFor } = vi.hoisted(() => ({
	holder: { db: null as unknown },
	mockClientFor: vi.fn(),
}));

vi.mock('$lib/server/db.js', () => ({
	get db() {
		return holder.db;
	},
}));
vi.mock('$lib/server/van-env.js', () => ({ vanClientFor: mockClientFor }));
vi.mock('$lib/server/autocomplete-sources.js', () => ({
	getSolidarityChapters: vi.fn(async () => ({ items: [{ id: 71, name: 'Wayne County' }] })),
}));

import { load } from './+page.server.js';

let client: ReturnType<typeof createClient>;

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true };

type Data = {
	campaign: { id: number; name: string };
	campaigns: Array<{ id: number; name: string }>;
	folders: Array<{ folderId: number; name: string }>;
	mapping: Array<{ folderId: number; chapters: Array<{ chapterId: number }> }>;
	error: string | null;
};

function run(query = '') {
	return load({
		locals: { session: ADMIN },
		url: new URL(`http://localhost/turfs/folder-map${query}`),
	} as never) as Promise<Data>;
}

/** A VAN client for one campaign: one folder, named for it, with one region. */
function clientFor(campaign: { id: number }) {
	return {
		ok: true,
		client: {
			folders: async () => [{ folderId: 10, name: `Folder of ${campaign.id}` }],
			mapRegions: async () => [
				{ mapRegionId: 1, name: 'R10C_Wayne_Detroit001', mapRoutes: [{ mapRouteId: 1 }] },
			],
		},
	};
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	holder.db = drizzle(client);
	await migrate(holder.db as ReturnType<typeof drizzle>, { migrationsFolder: 'drizzle' });
	await client.execute(
		`INSERT INTO van_campaigns (id, credential_key, label, enabled, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (2, 'abdul', 'Partner', 0, 'sync', 'sync', 'x')`,
	);
	// Folder 10 is mapped in campaign 2 only.
	await client.execute(
		`INSERT INTO van_chapter_folders
		   (campaign_id, chapter_id, folder_id, chapter_name,
		    last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (2, 71, 10, 'Wayne County', 'test', 'test', 'x')`,
	);
	vi.clearAllMocks();
	mockClientFor.mockImplementation(clientFor);
});

describe('which campaign', () => {
	it('shows the primary campaign by default, with every campaign to switch to', async () => {
		const data = await run('?refresh=1');
		expect(data.campaign.id).toBe(1);
		expect(data.campaigns.map((c) => c.id)).toEqual([1, 2]);
		expect(mockClientFor).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
		expect(data.folders.map((f) => f.name)).toEqual(['Folder of 1']);
		expect(data.mapping).toEqual([{ folderId: 10, chapters: [] }]);
	});

	it('reads another campaign’s folders with its key, and shows its mapping', async () => {
		const data = await run('?campaign=2&refresh=1');
		expect(data.campaign).toEqual({ id: 2, name: 'Partner' });
		expect(mockClientFor).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
		expect(data.folders.map((f) => f.name)).toEqual(['Folder of 2']);
		expect(data.mapping).toEqual([
			{ folderId: 10, chapters: [{ chapterId: 71, chapterName: 'Wayne County' }] },
		]);
	});

	// The cache is per campaign: one campaign's folders must never be served
	// on another's page.
	it('caches each campaign’s folders separately', async () => {
		await run('?campaign=1&refresh=1');
		await run('?campaign=2&refresh=1');
		mockClientFor.mockClear();

		expect((await run('?campaign=1')).folders[0]!.name).toBe('Folder of 1');
		expect((await run('?campaign=2')).folders[0]!.name).toBe('Folder of 2');
		expect(mockClientFor).not.toHaveBeenCalled();
	});

	it('says why when the campaign has no credentials, rather than failing the page', async () => {
		mockClientFor.mockReturnValue({ ok: false, error: 'VAN_CAMPAIGN_ABDUL is not set' });
		const data = await run('?campaign=2&refresh=1');
		expect(data.error).toBe('VAN_CAMPAIGN_ABDUL is not set');
	});

	it('404s for a campaign that does not exist', async () => {
		await expect(run('?campaign=99')).rejects.toMatchObject({ status: 404 });
	});
});

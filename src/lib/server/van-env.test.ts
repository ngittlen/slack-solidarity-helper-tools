import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import {
	vanClient,
	vanClientFor,
	isVanConfigured,
	vanExportJobTypeId,
	vanExportJobTypeIdFor,
	ensureCampaignRows,
	enabledVanCampaigns,
} from './van-env.js';
import { vanCampaigns } from './schema.js';

const mockEnv = vi.hoisted(() => ({
	VAN_APP_NAME: 'campaign-app',
	VAN_API_KEY: 'key-guid',
	VAN_DATABASE_MODE: '0',
	VAN_EXPORT_JOB_TYPE_ID: 8,
	/** VAN_CAMPAIGN_<KEY> secrets. */
	campaigns: {} as Record<string, string>,
}));

// vanCampaignCredentials runs the real parser over the mocked env, so the
// legacy-var cases below go through exactly the path production does. Not
// memoised here, unlike env.ts, so each test can change the env.
vi.mock('./env.js', async () => {
	const { parseVanCampaigns } = await import('./van/campaign-credentials.js');
	return {
		get VAN_APP_NAME() {
			return mockEnv.VAN_APP_NAME;
		},
		get VAN_API_KEY() {
			return mockEnv.VAN_API_KEY;
		},
		get VAN_DATABASE_MODE() {
			return mockEnv.VAN_DATABASE_MODE;
		},
		get VAN_EXPORT_JOB_TYPE_ID() {
			return mockEnv.VAN_EXPORT_JOB_TYPE_ID;
		},
		VAN_ID_HASH_SECRET: '',
		vanCampaignCredentials: () =>
			parseVanCampaigns({
				VAN_APP_NAME: mockEnv.VAN_APP_NAME,
				VAN_API_KEY: mockEnv.VAN_API_KEY,
				VAN_DATABASE_MODE: mockEnv.VAN_DATABASE_MODE,
				...mockEnv.campaigns,
			}),
	};
});

const campaignSecret = (databaseMode = 0) =>
	JSON.stringify({ appName: 'other-app', apiKey: 'other-key', databaseMode });

beforeEach(() => {
	mockEnv.VAN_APP_NAME = 'campaign-app';
	mockEnv.VAN_API_KEY = 'key-guid';
	mockEnv.VAN_DATABASE_MODE = '0';
	mockEnv.VAN_EXPORT_JOB_TYPE_ID = 8;
	mockEnv.campaigns = {};
});

describe('vanClient', () => {
	beforeEach(() => {
		mockEnv.VAN_APP_NAME = 'campaign-app';
		mockEnv.VAN_API_KEY = 'key-guid';
		mockEnv.VAN_DATABASE_MODE = '0';
		mockEnv.VAN_EXPORT_JOB_TYPE_ID = 8;
	});

	it('builds a client when fully configured', () => {
		const result = vanClient();
		expect(result.ok).toBe(true);
		expect(isVanConfigured()).toBe(true);
	});

	it('accepts My Campaign mode', () => {
		mockEnv.VAN_DATABASE_MODE = '1';
		expect(vanClient().ok).toBe(true);
	});

	it.each([
		['VAN_APP_NAME', 'VAN_APP_NAME' as const],
		['VAN_API_KEY', 'VAN_API_KEY' as const],
	])('reports %s missing rather than throwing', (_label, key) => {
		mockEnv[key] = '';
		const result = vanClient();
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain('VAN_APP_NAME/VAN_API_KEY');
		expect(isVanConfigured()).toBe(false);
	});

	// The wrong database mode authenticates successfully and returns a
	// different, near-empty database — a failure that reads as "the campaign
	// has no turf". Defaulting to 0 would hide it, so an unset value is an
	// error rather than an assumption.
	it.each(['', '2', 'My Voters', ' '])('rejects VAN_DATABASE_MODE %j', (mode) => {
		mockEnv.VAN_DATABASE_MODE = mode;
		const result = vanClient();
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain('VAN_DATABASE_MODE');
	});
});

describe('vanExportJobTypeId', () => {
	it('returns the configured id', () => {
		mockEnv.VAN_EXPORT_JOB_TYPE_ID = 8;
		expect(vanExportJobTypeId()).toBe(8);
	});

	it('returns null when unset, so the catalog sync still runs', () => {
		mockEnv.VAN_EXPORT_JOB_TYPE_ID = 0;
		expect(vanExportJobTypeId()).toBeNull();
	});

	it('returns null for an unparseable value', () => {
		mockEnv.VAN_EXPORT_JOB_TYPE_ID = NaN;
		expect(vanExportJobTypeId()).toBeNull();
	});
});

describe('vanClientFor', () => {
	it('builds a client from a campaign secret', () => {
		mockEnv.campaigns = { VAN_CAMPAIGN_OTHER: campaignSecret(1) };
		expect(vanClientFor({ credentialKey: 'other' }).ok).toBe(true);
	});

	it('names the missing secret', () => {
		const result = vanClientFor({ credentialKey: 'other' });
		expect(result).toEqual({ ok: false, error: 'VAN_CAMPAIGN_OTHER is not set' });
	});

	it('mentions the legacy vars when primary has no credentials at all', () => {
		mockEnv.VAN_APP_NAME = '';
		mockEnv.VAN_API_KEY = '';
		mockEnv.VAN_DATABASE_MODE = '';
		const result = vanClientFor({ credentialKey: 'primary' });
		expect(result.ok === false && result.error).toBe(
			'VAN_CAMPAIGN_PRIMARY (or VAN_APP_NAME/VAN_API_KEY) is not set',
		);
	});

	it("passes on the secret's own parse error", () => {
		mockEnv.campaigns = { VAN_CAMPAIGN_OTHER: 'not json' };
		const result = vanClientFor({ credentialKey: 'other' });
		expect(result).toEqual({ ok: false, error: 'VAN_CAMPAIGN_OTHER is not valid JSON' });
	});

	it("does not let one campaign's broken secret affect another", () => {
		mockEnv.campaigns = { VAN_CAMPAIGN_OTHER: 'not json' };
		expect(vanClient().ok).toBe(true);
	});

	it('lets VAN_CAMPAIGN_PRIMARY replace the legacy vars', () => {
		mockEnv.VAN_API_KEY = '';
		mockEnv.campaigns = { VAN_CAMPAIGN_PRIMARY: campaignSecret() };
		expect(vanClient().ok).toBe(true);
	});
});

describe('vanExportJobTypeIdFor', () => {
	it("uses the campaign's own job type", () => {
		expect(vanExportJobTypeIdFor({ credentialKey: 'other', exportJobTypeId: 12 })).toBe(12);
		expect(vanExportJobTypeIdFor({ credentialKey: 'primary', exportJobTypeId: 12 })).toBe(12);
	});

	it('falls back to VAN_EXPORT_JOB_TYPE_ID for primary only', () => {
		expect(vanExportJobTypeIdFor({ credentialKey: 'primary', exportJobTypeId: null })).toBe(8);
		expect(vanExportJobTypeIdFor({ credentialKey: 'other', exportJobTypeId: null })).toBeNull();
	});
});

describe('campaign rows', () => {
	let client: ReturnType<typeof createClient>;
	let db: ReturnType<typeof drizzle>;

	beforeEach(async () => {
		client = createClient({ url: ':memory:' });
		db = drizzle(client);
		await migrate(db, { migrationsFolder: 'drizzle' });
	});

	afterEach(() => client.close());

	it('seeds the campaign the app has always served, enabled and unnamed', async () => {
		const rows = await db.select().from(vanCampaigns);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: 1,
			credentialKey: 'primary',
			label: null,
			enabled: true,
			exportJobTypeId: null,
		});
	});

	it('adds a disabled row for a new campaign secret, once', async () => {
		mockEnv.campaigns = { VAN_CAMPAIGN_OTHER: campaignSecret() };
		expect(await ensureCampaignRows(db)).toEqual(['other']);
		expect(await ensureCampaignRows(db)).toEqual([]);

		const [row] = await db
			.select()
			.from(vanCampaigns)
			.where(eq(vanCampaigns.credentialKey, 'other'));
		expect(row).toMatchObject({ label: null, enabled: false, lastEditedBy: 'system' });
		expect(await db.select().from(vanCampaigns)).toHaveLength(2);
	});

	// So the settings page can show the campaign alongside what is wrong with it.
	it('adds a row for a secret that fails to parse, but not for a malformed secret name', async () => {
		mockEnv.campaigns = { VAN_CAMPAIGN_BROKEN: 'not json', VAN_CAMPAIGN_bad: campaignSecret() };
		expect(await ensureCampaignRows(db)).toEqual(['broken']);
	});

	it('leaves an existing row alone', async () => {
		await db
			.update(vanCampaigns)
			.set({ label: 'Renamed', enabled: false })
			.where(eq(vanCampaigns.id, 1));
		await ensureCampaignRows(db);
		const [row] = await db.select().from(vanCampaigns).where(eq(vanCampaigns.id, 1));
		expect(row).toMatchObject({ label: 'Renamed', enabled: false });
	});

	// A key that matches a label an admin chose for another campaign must still
	// get its row: discovery never sets a label, so the two cannot collide.
	it("adds a campaign whose key matches another campaign's label", async () => {
		await db.update(vanCampaigns).set({ label: 'other' }).where(eq(vanCampaigns.id, 1));
		mockEnv.campaigns = { VAN_CAMPAIGN_OTHER: campaignSecret() };
		expect(await ensureCampaignRows(db)).toEqual(['other']);
	});

	it('lets any number of campaigns be unnamed', async () => {
		mockEnv.campaigns = { VAN_CAMPAIGN_A: campaignSecret(), VAN_CAMPAIGN_B: campaignSecret() };
		expect((await ensureCampaignRows(db)).sort()).toEqual(['a', 'b']);
		const rows = await db.select().from(vanCampaigns);
		expect(rows.map((r) => r.label)).toEqual([null, null, null]);
	});

	it('still refuses two campaigns with the same name', async () => {
		mockEnv.campaigns = { VAN_CAMPAIGN_OTHER: campaignSecret() };
		await ensureCampaignRows(db);
		await db.update(vanCampaigns).set({ label: 'Senate' }).where(eq(vanCampaigns.id, 1));
		await expect(
			db
				.update(vanCampaigns)
				.set({ label: 'Senate' })
				.where(eq(vanCampaigns.credentialKey, 'other')),
		).rejects.toThrow();
	});

	it('lists only enabled campaigns, each with its client', async () => {
		mockEnv.campaigns = { VAN_CAMPAIGN_OTHER: campaignSecret() };
		await ensureCampaignRows(db);
		const enabled = await enabledVanCampaigns(db);
		expect(enabled.map((e) => e.campaign.credentialKey)).toEqual(['primary']);
		expect(enabled[0]!.client.ok).toBe(true);
	});
});

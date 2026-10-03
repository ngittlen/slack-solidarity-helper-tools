import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// Which campaigns the Packet Tracker runs for, and with what rules and tab
// (specs/012-multi-van-campaigns). A real in-memory database, because which
// campaign a turf belongs to and whether it keeps a tracker IS the behaviour;
// the store's Sheets work is spied on — it has its own tests.

const { mockSheetsClient, mockSync, mockLive } = vi.hoisted(() => ({
	mockSheetsClient: vi.fn(),
	mockSync: vi.fn(),
	mockLive: vi.fn(),
}));

vi.mock('../google-env.js', () => ({ sheetsClient: mockSheetsClient }));
vi.mock('../slack.js', () => ({ postAlert: vi.fn(async () => true) }));
vi.mock('./packet-tracker-store.js', () => ({
	syncPacketTracker: mockSync,
	liveAssignment: mockLive,
}));

import { packetTrackerCheck, runPacketTracker } from './packet-tracker-live.js';

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const EMPTY_RESULT = {
	filled: 0,
	updated: 0,
	failed: 0,
	deferred: 0,
	unrouted: 0,
	unroutedRegions: [],
	assignmentsChanged: 0,
	budgetLapsed: false,
	warnings: [],
};

async function campaign(
	id: number,
	over: { sheets?: boolean; enabled?: boolean; tab?: string | null } = {},
) {
	await client.execute({
		sql: `INSERT INTO van_campaigns
		        (id, credential_key, enabled, sheets_enabled, sheet_tab_name,
		         last_edited_by, last_edited_by_name, last_edited_at)
		      VALUES (?, ?, ?, ?, ?, 'test', 'test', 'x')
		      ON CONFLICT (id) DO UPDATE SET
		        enabled = excluded.enabled, sheets_enabled = excluded.sheets_enabled,
		        sheet_tab_name = excluded.sheet_tab_name`,
		args: [
			id,
			`campaign${id}`,
			(over.enabled ?? true) ? 1 : 0,
			(over.sheets ?? true) ? 1 : 0,
			over.tab ?? null,
		],
	});
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

async function turf(turfId: number, campaignId: number) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id,
		         chapter_name, region_name, name, route_size, door_count, first_seen_at, last_seen_at)
		      VALUES (?1, ?2, ?1, 1, 1, 71, 'Wayne County', 'R10C_Wayne', 'Turf', 120, 50, 'x', 'x')`,
		args: [turfId, campaignId],
	});
}

const TURF = { regionName: 'R10C_Wayne', printedListNumber: '1-1' };

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	vi.clearAllMocks();
	mockSheetsClient.mockReturnValue({ ok: true, client: {} });
	mockSync.mockResolvedValue(EMPTY_RESULT);
	mockLive.mockResolvedValue('Organizer Olu');
	// The migration's campaign 1 keeps a tracker, as One Team Michigan does.
	await campaign(1, { tab: 'Packets' });
	await rule(1, 'R10C', 'sheet-primary');
});

describe('the scheduled run', () => {
	it('runs each campaign with sheets on, with its own rules and tab', async () => {
		await campaign(2, { tab: null });
		await rule(2, 'R10C', 'sheet-partner');

		await runPacketTracker(db, { timeBudgetMs: 30_000, channelId: 'C' });

		expect(mockSync).toHaveBeenCalledTimes(2);
		const [first, second] = mockSync.mock.calls.map((c) => c[1]);
		expect(first).toMatchObject({ campaignId: 1, tabName: 'Packets' });
		expect(first.targets.map((t: { spreadsheetId: string }) => t.spreadsheetId)).toEqual([
			'sheet-primary',
		]);
		expect(second).toMatchObject({ campaignId: 2, tabName: undefined });
		expect(second.targets.map((t: { spreadsheetId: string }) => t.spreadsheetId)).toEqual([
			'sheet-partner',
		]);
	});

	it('skips a campaign with sheets off, whatever rules it has', async () => {
		await campaign(2, { sheets: false });
		await rule(2, 'R10C', 'sheet-partner');

		await runPacketTracker(db, { timeBudgetMs: 30_000, channelId: 'C' });

		expect(mockSync).toHaveBeenCalledOnce();
		expect(mockSync.mock.calls[0]![1].campaignId).toBe(1);
	});

	// Its claims are still running, and the spreadsheet should say so to the
	// end. Turning its Sheets switch off is what stops the writes.
	it('still runs for a disabled campaign that has sheets on', async () => {
		await campaign(1, { enabled: false, tab: 'Packets' });

		await runPacketTracker(db, { timeBudgetMs: 30_000, channelId: 'C' });

		expect(mockSync).toHaveBeenCalledOnce();
	});

	it('does nothing when no campaign keeps a tracker', async () => {
		await campaign(1, { sheets: false });

		expect(await runPacketTracker(db, { timeBudgetMs: 30_000, channelId: 'C' })).toBeNull();
		expect(mockSync).not.toHaveBeenCalled();
	});

	it('adds the campaigns’ results together', async () => {
		await campaign(2);
		await rule(2, 'R10C', 'sheet-partner');
		mockSync
			.mockResolvedValueOnce({ ...EMPTY_RESULT, filled: 1, unrouted: 1, unroutedRegions: ['A'] })
			.mockResolvedValueOnce({ ...EMPTY_RESULT, filled: 2, unrouted: 1, unroutedRegions: ['B'] });

		const result = await runPacketTracker(db, { timeBudgetMs: 30_000, channelId: 'C' });

		expect(result).toMatchObject({ filled: 3, unrouted: 2, unroutedRegions: ['A', 'B'] });
	});
});

describe('one turf', () => {
	it('runs only the turf’s own campaign for a nudge', async () => {
		await campaign(2);
		await rule(2, 'R10C', 'sheet-partner');
		await turf(200, 2);

		await runPacketTracker(db, { timeBudgetMs: 20_000, channelId: '', onlyTurfId: 200 });

		expect(mockSync).toHaveBeenCalledOnce();
		expect(mockSync.mock.calls[0]![1]).toMatchObject({ campaignId: 2, onlyTurfId: 200 });
	});

	it('makes no Google call for a turf whose campaign keeps no tracker', async () => {
		await campaign(2, { sheets: false });
		await rule(2, 'R10C', 'sheet-partner');
		await turf(200, 2);

		expect(
			await runPacketTracker(db, { timeBudgetMs: 20_000, channelId: '', onlyTurfId: 200 }),
		).toBeNull();
		expect(await packetTrackerCheck(db)({ turfId: 200, ...TURF })).toBeUndefined();
		expect(mockSync).not.toHaveBeenCalled();
		expect(mockLive).not.toHaveBeenCalled();
	});

	it('checks a claim live against its own campaign’s spreadsheets and tab', async () => {
		await turf(100, 1);

		expect(await packetTrackerCheck(db)({ turfId: 100, ...TURF })).toBe('Organizer Olu');
		expect(mockLive.mock.calls[0]![1]).toMatchObject({ tabName: 'Packets' });
		expect(mockLive.mock.calls[0]![1].targets).toEqual([
			expect.objectContaining({ spreadsheetId: 'sheet-primary' }),
		]);
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { migrate } from 'drizzle-orm/libsql/migrator';

const {
	mockHasher,
	mockWithSyncLock,
	mockRunContactSync,
	mockClear,
	mockNudgeTracker,
	mockClientFor,
} = vi.hoisted(() => ({
	mockHasher: vi.fn(),
	mockWithSyncLock: vi.fn(),
	mockRunContactSync: vi.fn(),
	mockClear: vi.fn(),
	mockNudgeTracker: vi.fn(),
	mockClientFor: vi.fn(),
}));

vi.mock('../van-env.js', () => ({
	vanPersonHasher: mockHasher,
	vanClientFor: mockClientFor,
}));
vi.mock('../sync-lock.js', () => ({ withSyncLock: mockWithSyncLock }));
vi.mock('./contact-sync.js', () => ({
	runContactSync: mockRunContactSync,
	clearUncontacted: mockClear,
}));
vi.mock('./packet-tracker-live.js', () => ({ nudgePacketTracker: mockNudgeTracker }));

import { nudgeWithRetry, runContactStage } from './contact-live.js';

/** The turf's campaign, as the nudge looks it up: turf 42 is campaign 2's. */
const CAMPAIGN = { id: 2, credentialKey: 'other' };
const db = {
	select: () => ({
		from: () => ({ innerJoin: () => ({ where: async () => [CAMPAIGN] }) }),
	}),
} as unknown as ReturnType<typeof drizzle>;
const RESULT = { percentsStamped: 1, error: null };
const noSleep = async () => {};

/** A lock that is taken for the first `busyFor` attempts, then free. */
function lockBusyFor(busyFor: number) {
	let attempts = 0;
	mockWithSyncLock.mockImplementation(async (_db, _name, _ttl, fn: () => Promise<unknown>) =>
		++attempts <= busyFor ? { skipped: true } : { skipped: false, result: await fn() },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasher.mockReturnValue({});
	mockRunContactSync.mockResolvedValue(RESULT);
	mockClientFor.mockReturnValue({ ok: true, client: {} });
});

describe('nudgeWithRetry', () => {
	// Another volunteer's nudge recomputes only its own turf, so giving up here
	// would leave this one waiting for the scheduled sync.
	it('waits out a run already holding the lock, then pulls for its own turf', async () => {
		lockBusyFor(2);
		const sleep = vi.fn(noSleep);

		await nudgeWithRetry(db, 42, { sleep, retryMs: 5, waitMs: 60 });

		expect(mockWithSyncLock).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
		// The turf's own campaign: its key, its lock, its ContactHistory.
		expect(mockClientFor).toHaveBeenCalledWith(CAMPAIGN);
		expect(mockWithSyncLock).toHaveBeenCalledWith(
			db,
			'van-contact-sync:2',
			expect.any(Number),
			expect.any(Function),
		);
		expect(mockRunContactSync).toHaveBeenCalledWith(
			db,
			{},
			expect.objectContaining({ campaignId: 2, recomputeTurfIds: [42] }),
		);
		expect(mockNudgeTracker).toHaveBeenCalledWith(db, 42);
	});

	it('gives up once the lock has been held past every holder’s budget', async () => {
		lockBusyFor(Infinity);
		const sleep = vi.fn(noSleep);

		await nudgeWithRetry(db, 42, { sleep, retryMs: 5, waitMs: 15 });

		expect(sleep).toHaveBeenCalledTimes(3);
		expect(mockRunContactSync).not.toHaveBeenCalled();
	});

	it('does not wait when the count is switched off', async () => {
		mockHasher.mockReturnValue(null);
		const sleep = vi.fn(noSleep);

		await nudgeWithRetry(db, 42, { sleep });

		expect(sleep).not.toHaveBeenCalled();
		expect(mockWithSyncLock).not.toHaveBeenCalled();
		expect(mockClear).toHaveBeenCalled();
	});

	it('leaves the Packet Tracker alone when no % moved', async () => {
		lockBusyFor(0);
		mockRunContactSync.mockResolvedValue({ percentsStamped: 0, error: null });

		await nudgeWithRetry(db, 42, { sleep: noSleep });

		expect(mockNudgeTracker).not.toHaveBeenCalled();
	});
});

describe('runContactStage', () => {
	// A disabled campaign makes no VAN calls (specs/012-multi-van-campaigns):
	// its claims run to their end, but their counts are not refreshed. On a real
	// database, because the filter is SQL.
	it('makes no VAN call for a turf in a disabled campaign', async () => {
		const client = createClient({ url: ':memory:' });
		const real = drizzle(client);
		await migrate(real, { migrationsFolder: 'drizzle' });
		await client.execute(
			`INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (2, 'other', 0, 's', 's', 'x')`,
		);
		await client.execute(
			`INSERT INTO van_turfs (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id,
			   chapter_id, name, first_seen_at, last_seen_at)
			 VALUES (42, 2, 42, 1, 1, 71, 'T', 'x', 'x')`,
		);
		await nudgeWithRetry(real, 42, { sleep: noSleep });
		expect(mockClientFor).not.toHaveBeenCalled();
		expect(mockRunContactSync).not.toHaveBeenCalled();

		await client.execute('UPDATE van_campaigns SET enabled = 1 WHERE id = 2');
		mockWithSyncLock.mockImplementation(async (_db, _name, _ttl, fn: () => Promise<unknown>) => ({
			skipped: false,
			result: await fn(),
		}));
		await nudgeWithRetry(real, 42, { sleep: noSleep });
		expect(mockRunContactSync).toHaveBeenCalledOnce();
		client.close();
	});

	it("is off for a campaign without a usable key, without touching another's", async () => {
		mockClientFor.mockReturnValue({ ok: false, error: 'VAN_CAMPAIGN_OTHER is not set' });
		expect(await runContactStage(db, CAMPAIGN, { timeBudgetMs: 1000 })).toBeNull();
		expect(mockWithSyncLock).not.toHaveBeenCalled();
	});

	// The scheduled sync does not wait: it runs every half hour anyway.
	it('returns null at once when the lock is held', async () => {
		lockBusyFor(1);
		expect(await runContactStage(db, CAMPAIGN, { timeBudgetMs: 1000 })).toBeNull();
		expect(mockWithSyncLock).toHaveBeenCalledTimes(1);
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { drizzle } from 'drizzle-orm/libsql';

const { mockHasher, mockWithSyncLock, mockRunContactSync, mockClear, mockNudgeTracker } =
	vi.hoisted(() => ({
		mockHasher: vi.fn(),
		mockWithSyncLock: vi.fn(),
		mockRunContactSync: vi.fn(),
		mockClear: vi.fn(),
		mockNudgeTracker: vi.fn(),
	}));

vi.mock('../van-env.js', () => ({
	vanPersonHasher: mockHasher,
	vanClient: () => ({ ok: true, client: {} }),
}));
vi.mock('../sync-lock.js', () => ({ withSyncLock: mockWithSyncLock }));
vi.mock('./contact-sync.js', () => ({
	runContactSync: mockRunContactSync,
	clearUncontacted: mockClear,
}));
vi.mock('./packet-tracker-live.js', () => ({ nudgePacketTracker: mockNudgeTracker }));

import { nudgeWithRetry, runContactStage } from './contact-live.js';

const db = {} as ReturnType<typeof drizzle>;
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
		expect(mockRunContactSync).toHaveBeenCalledWith(
			db,
			{},
			expect.objectContaining({ recomputeTurfIds: [42] }),
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
	// The scheduled sync does not wait: it runs every half hour anyway.
	it('returns null at once when the lock is held', async () => {
		lockBusyFor(1);
		expect(await runContactStage(db, { timeBudgetMs: 1000 })).toBeNull();
		expect(mockWithSyncLock).toHaveBeenCalledTimes(1);
	});
});

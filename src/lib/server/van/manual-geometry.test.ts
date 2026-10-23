import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { acquireSyncLock, releaseSyncLock } from '../sync-lock.js';
import { vanSyncLock } from './locks.js';
import type { GeometryWorkerResult } from './geometry-worker.js';
import type { VanClient } from './client.js';

vi.mock('../env.js', () => ({
	APP_URL: 'https://app.example.test',
	INTERNAL_CRON_SECRET: 'secret',
	VAN_EXPORT_JOB_TYPE_ID: '',
	VAN_ID_HASH_SECRET: '',
	vanCampaignCredentials: () => ({ credentials: new Map(), errors: new Map() }),
}));
vi.mock('../slack.js', () => ({ alertFor: () => async () => {} }));
vi.mock('../settings.js', () => ({ loadSettings: async () => ({ slackTurfChannelId: '' }) }));

const { drainGeometryForPress } = await import('./manual-geometry.js');

// A real in-memory libsql with the real schema: the migrations seed the
// primary campaign, enabled, and the lock is the real atomic upsert.
let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

const configured = {
	clientFor: () => ({ ok: true as const, client: {} as VanClient }),
	exportJobTypeIdFor: () => 5,
	yieldMs: 0,
	place: async () => {},
};

function slice(over: Partial<GeometryWorkerResult>): GeometryWorkerResult {
	return { attempted: 0, hullsStored: 0, centroidsOnly: 0, budgetLapsed: false, ...over } as never;
}

/** A worker that answers each slice in turn, and records what it was asked. */
function worker(slices: Partial<GeometryWorkerResult>[]) {
	const options: Record<string, unknown>[] = [];
	const run = vi.fn(async (_db: unknown, _client: unknown, opts: Record<string, unknown>) => {
		options.push(opts);
		// The lock is held while a slice runs.
		expect(await acquireSyncLock(db, vanSyncLock(1), 1000)).toBeNull();
		return slice(slices[options.length - 1] ?? {});
	});
	return { run: run as never, options };
}

describe('drainGeometryForPress', () => {
	it('keeps slicing past a hundred turfs until the queue is through', async () => {
		const { run, options } = worker([
			{ attempted: 60, hullsStored: 55, centroidsOnly: 3, budgetLapsed: true },
			{ attempted: 60, hullsStored: 60, budgetLapsed: true },
			{ attempted: 20, hullsStored: 18, budgetLapsed: false },
		]);
		const [drained] = await drainGeometryForPress(db, { ...configured, run });
		expect(drained).toEqual({ campaignId: 1, attempted: 140, mapped: 136 });
		expect(options).toHaveLength(3);
		// No cap on turfs: each slice takes as many as its time allows.
		expect(options[0]).not.toHaveProperty('maxItems');
		expect(options[0]).toMatchObject({ campaignId: 1, exportJobTypeId: 5, concurrency: 4 });
		// The lock is free between slices and after.
		expect(await acquireSyncLock(db, vanSyncLock(1), 1000)).not.toBeNull();
	});

	it('stops when a slice finds nothing to start', async () => {
		const { run, options } = worker([{ attempted: 0, budgetLapsed: true }]);
		const [drained] = await drainGeometryForPress(db, { ...configured, run });
		expect(drained).toEqual({ campaignId: 1, attempted: 0, mapped: 0 });
		expect(options).toHaveLength(1);
	});

	it('does nothing for a campaign without geometry configured', async () => {
		const { run, options } = worker([]);
		const [drained] = await drainGeometryForPress(db, {
			...configured,
			exportJobTypeIdFor: () => null,
			run,
		});
		expect(drained).toMatchObject({ attempted: 0, stopped: 'not configured' });
		expect(options).toHaveLength(0);
	});

	it('waits for a scheduled sync holding the lock, then gives up', async () => {
		const held = (await acquireSyncLock(db, vanSyncLock(1), 60_000))!;
		const { run, options } = worker([]);
		const [drained] = await drainGeometryForPress(db, {
			...configured,
			run,
			lockPollMs: 5,
			lockWaitMs: 30,
		});
		expect(drained).toMatchObject({ stopped: 'lock busy' });
		expect(options).toHaveLength(0);
		await releaseSyncLock(db, vanSyncLock(1), held);
	});

	it('takes the lock once a scheduled sync lets it go', async () => {
		const held = (await acquireSyncLock(db, vanSyncLock(1), 60_000))!;
		setTimeout(() => void releaseSyncLock(db, vanSyncLock(1), held), 20);
		const { run, options } = worker([{ attempted: 3, hullsStored: 3 }]);
		const [drained] = await drainGeometryForPress(db, { ...configured, run, lockPollMs: 5 });
		expect(drained).toEqual({ campaignId: 1, attempted: 3, mapped: 3 });
		expect(options).toHaveLength(1);
	});

	it('stops at its overall time budget with the queue still going', async () => {
		const { run, options } = worker(
			Array.from({ length: 50 }, () => ({ attempted: 1, budgetLapsed: true })),
		);
		const [drained] = await drainGeometryForPress(db, { ...configured, run, maxDrainMs: 0 });
		expect(drained).toMatchObject({ attempted: 0, stopped: 'out of time' });
		expect(options).toHaveLength(0);
	});

	it('holds the lock no longer than a waiting scheduled sync will wait for it', async () => {
		const { run, options } = worker([{ attempted: 1 }]);
		await drainGeometryForPress(db, { ...configured, run });
		const held = (options[0]!.timeBudgetMs as number) + (options[0]!.finishGraceMs as number);
		// The van-sync route's LOCK_WAIT_MS.
		expect(held).toBeLessThan(75_000);
	});

	it('stops between slices when a press asks for VAN to be read again', async () => {
		const { run, options } = worker(
			Array.from({ length: 5 }, () => ({ attempted: 10, hullsStored: 10, budgetLapsed: true })),
		);
		let asked = 0;
		const [drained] = await drainGeometryForPress(db, {
			...configured,
			run,
			// Asked after the second slice.
			shouldStop: async () => ++asked > 2,
		});
		expect(drained).toEqual({
			campaignId: 1,
			attempted: 20,
			mapped: 20,
			stopped: 'resync requested',
		});
		expect(options).toHaveLength(2);
		expect(await acquireSyncLock(db, vanSyncLock(1), 1000)).not.toBeNull();
	});

	it('lets a waiting sync take the lock between slices', async () => {
		const options: unknown[] = [];
		let sawFree = false;
		const run = vi.fn(async () => {
			options.push(1);
			return slice({ attempted: 1, hullsStored: 1, budgetLapsed: options.length < 2 });
		});
		const drain = drainGeometryForPress(db, {
			...configured,
			run: run as never,
			yieldMs: 50,
		});
		// During the pause after the first slice, the lock is free to take.
		await vi.waitFor(() => expect(options).toHaveLength(1));
		await vi.waitFor(async () => {
			const token = await acquireSyncLock(db, vanSyncLock(1), 1);
			expect(token).not.toBeNull();
			sawFree = true;
		});
		await drain;
		expect(sawFree).toBe(true);
	});

	it('stops at the deadline it is given', async () => {
		const { run, options } = worker([{ attempted: 1 }]);
		const [drained] = await drainGeometryForPress(db, {
			...configured,
			run,
			deadline: Date.now() - 1,
		});
		expect(drained).toMatchObject({ stopped: 'out of time' });
		expect(options).toHaveLength(0);
	});

	// One campaign's backlog must not spend the drain while another's new turf
	// waits.
	it('gives each campaign a slice in turn', async () => {
		// A copy of the seeded campaign, as a second enabled one.
		await client.executeMultiple(`
			CREATE TEMP TABLE second AS SELECT * FROM van_campaigns WHERE id = 1;
			UPDATE second SET id = 2, credential_key = 'second';
			INSERT INTO van_campaigns SELECT * FROM second;
		`);
		const order: number[] = [];
		const run = vi.fn(async (_db: unknown, _client: unknown, opts: { campaignId: number }) => {
			order.push(opts.campaignId);
			// Campaign 1 has a long backlog; campaign 2 is through in two slices.
			const more = opts.campaignId === 1 || order.filter((id) => id === 2).length < 2;
			return slice({ attempted: 5, hullsStored: 5, budgetLapsed: more && order.length < 6 });
		});
		const drained = await drainGeometryForPress(db, { ...configured, run: run as never });
		expect(order.slice(0, 4)).toEqual([1, 2, 1, 2]);
		expect(drained.map((d) => d.campaignId)).toEqual([1, 2]);
		expect(drained[1]).toEqual({ campaignId: 2, attempted: 10, mapped: 10 });
	});

	// A request shows up in its chapter as soon as it has a shape.
	it('places requested turf after a slice that put turf on the map', async () => {
		await client.execute('UPDATE van_campaigns SET requested_folder_id = 900 WHERE id = 1');
		const place = vi.fn(async () => {});
		const { run } = worker([
			{ attempted: 2, hullsStored: 2, budgetLapsed: true },
			{ attempted: 1, hullsStored: 0 },
		]);
		await drainGeometryForPress(db, { ...configured, run, place });
		// Before the shapes, after the first slice — the second mapped nothing —
		// and once at the end.
		expect(place).toHaveBeenCalledTimes(3);
		expect(place).toHaveBeenNthCalledWith(
			2,
			db,
			expect.objectContaining({ id: 1, requestedFolderId: 900 }),
			15_000,
		);
	});

	// A scheduled sync places only what its budget reaches; the press places
	// the rest, though it maps none of it — first, so a long shape queue cannot
	// leave it no time, and again at the end. Misses too: a press is how an
	// organizer asks for them again.
	it('places what is waiting before the shapes and once they are done', async () => {
		await client.execute('UPDATE van_campaigns SET requested_folder_id = 900 WHERE id = 1');
		const order: string[] = [];
		const place = vi.fn(async () => {
			order.push('place');
		});
		const run = vi.fn(async () => {
			order.push('slice');
			return slice({ attempted: 0 });
		});
		await drainGeometryForPress(db, { ...configured, run: run as never, place });
		expect(order).toEqual(['place', 'slice', 'place']);
		// Misses at the start only: the end is for turf the drain shaped.
		const calls = place.mock.calls as unknown[][];
		expect(calls.map((c) => c[3])).toEqual([true, false]);
		expect(calls[0]!.slice(0, 3)).toEqual([
			db,
			expect.objectContaining({ id: 1 }),
			expect.any(Number),
		]);
	});

	// A scheduled sync's twenty seconds, rather than leave the press's turf
	// to the next one.
	it('waits out another run placing the same campaign', async () => {
		await client.execute('UPDATE van_campaigns SET requested_folder_id = 900 WHERE id = 1');
		const busy = { byZip: 0, byNearby: 0, unplaced: 0, cleared: 0, budgetLapsed: false };
		const place = vi
			.fn()
			.mockResolvedValueOnce({ ...busy, busy: true })
			.mockResolvedValueOnce({ ...busy, byZip: 3 })
			.mockResolvedValue(busy);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { run } = worker([{ attempted: 0 }]);
		await drainGeometryForPress(db, { ...configured, run, place, placeBusyPollMs: 1 });
		expect(place).toHaveBeenCalledTimes(3);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining('requested turf placed'),
			expect.objectContaining({ byZip: 3 }),
		);
	});

	it('places even when the drain runs out of time on shapes', async () => {
		await client.execute('UPDATE van_campaigns SET requested_folder_id = 900 WHERE id = 1');
		const place = vi.fn(async () => {});
		// The slice takes the drain past its deadline — by the clock, so a slow
		// machine cannot make it so before the first placement.
		const realNow = Date.now;
		const run = vi.fn(async () => {
			const later = realNow() + 60 * 60 * 1000;
			vi.spyOn(Date, 'now').mockImplementation(() => later);
			return slice({ attempted: 5, budgetLapsed: true });
		});
		await drainGeometryForPress(db, {
			...configured,
			run: run as never,
			place,
			deadline: realNow() + 30 * 60 * 1000,
			yieldMs: 0,
		});
		expect(run).toHaveBeenCalledOnce();
		expect(place).toHaveBeenCalledOnce();
	});

	it('leaves the placing to the pass when a resync is asked for', async () => {
		await client.execute('UPDATE van_campaigns SET requested_folder_id = 900 WHERE id = 1');
		const place = vi.fn(async () => {});
		const { run } = worker([{ attempted: 0 }]);
		await drainGeometryForPress(db, {
			...configured,
			run,
			place,
			shouldStop: async () => true,
		});
		// The pass the resync runs places them.
		expect(place).not.toHaveBeenCalled();
	});

	it('places nothing for a campaign with no requested-turf folder', async () => {
		const place = vi.fn(async () => {});
		const { run } = worker([{ attempted: 2, hullsStored: 2 }]);
		await drainGeometryForPress(db, { ...configured, run, place });
		expect(place).not.toHaveBeenCalled();
	});

	// Reported with its error, for the press's record to say.
	it('frees the lock and carries on when a slice throws', async () => {
		const run = vi.fn(async () => {
			throw new Error('database is gone');
		});
		await expect(drainGeometryForPress(db, { ...configured, run: run as never })).resolves.toEqual([
			{ campaignId: 1, attempted: 0, mapped: 0, failed: 'database is gone' },
		]);
		expect(await acquireSyncLock(db, vanSyncLock(1), 1000)).not.toBeNull();
	});
});

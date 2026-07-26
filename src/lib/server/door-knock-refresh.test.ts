import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import {
	DOOR_KNOCK_REFRESH_MS,
	beginDoorKnockRefresh,
	claimDoorKnockRefresh,
	endDoorKnockRefresh,
	needsDoorKnockRefresh,
	readDoorKnockRefreshStatus,
	refreshDoorKnockIfStale,
	_resetDoorKnockRefreshState,
} from './door-knock-refresh.js';

// The claim is an atomic conditional UPSERT — the whole point is the SQL, so
// these run against a real in-memory SQLite rather than a mocked db chain.
let client: Client;
let db: LibSQLDatabase<Record<string, unknown>>;

beforeEach(async () => {
	_resetDoorKnockRefreshState();
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await client.execute(`CREATE TABLE door_knock_refresh (
		id integer PRIMARY KEY NOT NULL,
		started_at text NOT NULL,
		finished_at text,
		ok integer,
		error text,
		CONSTRAINT door_knock_refresh_singleton CHECK(door_knock_refresh.id = 1)
	)`);
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

const T0 = new Date('2026-07-25T14:00:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

describe('needsDoorKnockRefresh', () => {
	it('is true when no snapshot has ever run', () => {
		expect(needsDoorKnockRefresh({ startedAt: null, finishedAt: null }, T0.getTime())).toBe(true);
	});

	it('is false inside the window once the attempt finished', () => {
		const status = { startedAt: T0.toISOString(), finishedAt: T0.toISOString() };
		expect(needsDoorKnockRefresh(status, T0.getTime() + 29 * 60_000)).toBe(false);
	});

	it('is true once the window has elapsed', () => {
		const status = { startedAt: T0.toISOString(), finishedAt: T0.toISOString() };
		expect(needsDoorKnockRefresh(status, T0.getTime() + DOOR_KNOCK_REFRESH_MS)).toBe(true);
	});

	// A visitor arriving mid-run should wait on that run, not ignore it — the
	// endpoint's claim keeps them from starting a second one.
	it('is true while an attempt is still in flight', () => {
		const status = { startedAt: T0.toISOString(), finishedAt: null };
		expect(needsDoorKnockRefresh(status, T0.getTime() + 60_000)).toBe(true);
	});

	it('is true when the stored timestamp is unparseable', () => {
		expect(needsDoorKnockRefresh({ startedAt: 'nonsense', finishedAt: null }, T0.getTime())).toBe(
			true,
		);
	});
});

describe('claimDoorKnockRefresh', () => {
	it('wins the first claim and inserts the singleton row', async () => {
		expect(await claimDoorKnockRefresh(db, T0)).toBe(true);
		expect(await readDoorKnockRefreshStatus(db)).toEqual({
			startedAt: T0.toISOString(),
			finishedAt: null,
		});
	});

	it('refuses a second claim inside the window', async () => {
		expect(await claimDoorKnockRefresh(db, T0)).toBe(true);
		expect(await claimDoorKnockRefresh(db, plus(60_000))).toBe(false);
		// The loser must not have moved the window forward.
		expect((await readDoorKnockRefreshStatus(db)).startedAt).toBe(T0.toISOString());
	});

	it('grants a claim once the window has elapsed', async () => {
		await claimDoorKnockRefresh(db, T0);
		await endDoorKnockRefresh(db, plus(5_000), null);
		const later = plus(DOOR_KNOCK_REFRESH_MS);
		expect(await claimDoorKnockRefresh(db, later)).toBe(true);
		// Re-claiming clears the previous attempt's outcome.
		expect(await readDoorKnockRefreshStatus(db)).toEqual({
			startedAt: later.toISOString(),
			finishedAt: null,
		});
	});

	// Stamping at claim time (not on success) is what keeps a broken Openfield
	// from being hammered by every page view.
	it('throttles after a failed attempt just like a successful one', async () => {
		await claimDoorKnockRefresh(db, T0);
		await endDoorKnockRefresh(db, plus(2_000), 'openfield login failed');
		expect(await claimDoorKnockRefresh(db, plus(60_000))).toBe(false);
	});
});

describe('endDoorKnockRefresh', () => {
	it('records success', async () => {
		await claimDoorKnockRefresh(db, T0);
		await endDoorKnockRefresh(db, plus(1_000), null);
		const row = (await client.execute('SELECT ok, error, finished_at FROM door_knock_refresh'))
			.rows[0]!;
		expect(row.ok).toBe(1);
		expect(row.error).toBeNull();
		expect(row.finished_at).toBe(plus(1_000).toISOString());
	});

	it('records the failure message', async () => {
		await claimDoorKnockRefresh(db, T0);
		await endDoorKnockRefresh(db, plus(1_000), 'canvas fetch failed');
		const row = (await client.execute('SELECT ok, error FROM door_knock_refresh')).rows[0]!;
		expect(row.ok).toBe(0);
		expect(row.error).toBe('canvas fetch failed');
	});

	it('swallows write errors so it never masks the snapshot result', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		client.close();
		await expect(endDoorKnockRefresh(db, T0, null)).resolves.toBeUndefined();
	});
});

describe('beginDoorKnockRefresh', () => {
	// The scheduled snapshot always runs; it resets the window rather than
	// asking for it, so a visit right after the cron doesn't re-fetch.
	it('takes the window unconditionally, even inside a fresh one', async () => {
		await claimDoorKnockRefresh(db, T0);
		await endDoorKnockRefresh(db, plus(1_000), null);
		await beginDoorKnockRefresh(db, plus(60_000));
		expect(await readDoorKnockRefreshStatus(db)).toEqual({
			startedAt: plus(60_000).toISOString(),
			finishedAt: null,
		});
	});

	it('swallows write errors so it never blocks the scheduled snapshot', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		client.close();
		await expect(beginDoorKnockRefresh(db, T0)).resolves.toBeUndefined();
	});
});

describe('refreshDoorKnockIfStale', () => {
	it('runs the snapshot and marks the attempt finished', async () => {
		const run = vi.fn().mockResolvedValue({ rowsWritten: 3 });
		const outcome = await refreshDoorKnockIfStale(db, run, { now: () => T0 });
		expect(outcome).toEqual({ status: 'refreshed' });
		expect(run).toHaveBeenCalledTimes(1);
		expect(await readDoorKnockRefreshStatus(db)).toEqual({
			startedAt: T0.toISOString(),
			finishedAt: T0.toISOString(),
		});
	});

	it('skips without touching Openfield when the window is still fresh', async () => {
		await claimDoorKnockRefresh(db, T0);
		await endDoorKnockRefresh(db, T0, null);
		const run = vi.fn();
		const outcome = await refreshDoorKnockIfStale(db, run, { now: () => plus(60_000) });
		expect(outcome).toEqual({ status: 'skipped' });
		expect(run).not.toHaveBeenCalled();
	});

	it('reports a failed snapshot without throwing, and stores the message', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const run = vi.fn().mockRejectedValue(new Error('openfield 503'));
		const outcome = await refreshDoorKnockIfStale(db, run, { now: () => T0 });
		expect(outcome).toEqual({ status: 'failed', error: 'openfield 503' });
		const row = (await client.execute('SELECT ok, error FROM door_knock_refresh')).rows[0]!;
		expect(row.ok).toBe(0);
		expect(row.error).toBe('openfield 503');
	});

	// Several visitors landing at once must share one Openfield run, and all of
	// them must be told when it's done so each can reload its chart.
	it('shares a single in-flight run between concurrent callers', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const run = vi.fn(() => gate);

		const first = refreshDoorKnockIfStale(db, run, { now: () => T0 });
		const second = refreshDoorKnockIfStale(db, run, { now: () => T0 });
		release();

		expect(await first).toEqual({ status: 'refreshed' });
		expect(await second).toEqual({ status: 'refreshed' });
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('releases the in-flight slot so a later stale visit can run again', async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		await refreshDoorKnockIfStale(db, run, { now: () => T0 });
		const later = plus(DOOR_KNOCK_REFRESH_MS);
		expect(await refreshDoorKnockIfStale(db, run, { now: () => later })).toEqual({
			status: 'refreshed',
		});
		expect(run).toHaveBeenCalledTimes(2);
	});

	it('honours a custom window', async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		await refreshDoorKnockIfStale(db, run, { now: () => T0, intervalMs: 1_000 });
		const outcome = await refreshDoorKnockIfStale(db, run, {
			now: () => plus(1_500),
			intervalMs: 1_000,
		});
		expect(outcome).toEqual({ status: 'refreshed' });
		expect(run).toHaveBeenCalledTimes(2);
	});
});

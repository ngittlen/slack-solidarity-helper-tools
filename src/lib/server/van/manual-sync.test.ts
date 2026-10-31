import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { acquireSyncLock, releaseSyncLock } from '../sync-lock.js';
import type { Caller } from '../scheduler.js';
import { VAN_LEDGER_LOCK, vanSyncLock } from './locks.js';
import {
	MANUAL_VAN_RESYNC,
	MANUAL_VAN_SYNC_LOCK,
	lastVanSyncs,
	latestManualVanSync,
	startManualVanSync,
} from './manual-sync.js';
import { failureReason } from './manual-sync-report.js';

// A real in-memory libsql with the real schema, like scheduler.test.ts: what
// stops two presses running two passes is the lock's atomic upsert, and the
// pass itself reads which campaigns are enabled (the migrations seed the
// primary one, enabled).
let db: LibSQLDatabase<Record<string, unknown>>;
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

const MINUTE = 60_000;
/** Heartbeats and watching quick enough for a test. */
const FAST = { heartbeatMs: 20, watchSlackMs: 10 };
/** A lock that is free again can be taken; one still held cannot. */
const lockIsFree = async () => (await acquireSyncLock(db, MANUAL_VAN_SYNC_LOCK, MINUTE)) !== null;
const expiresAt = async () =>
	(
		await client.execute({
			sql: 'SELECT expires_at FROM sync_locks WHERE name = ?',
			args: [MANUAL_VAN_SYNC_LOCK],
		})
	).rows[0]?.expires_at as string | undefined;

function recorder() {
	const calls: Record<string, string>[] = [];
	const call: Caller = async (_path, params) => {
		calls.push(params);
		return {};
	};
	return { calls, call };
}

/** A call that hangs until `finish` is called. */
function hanging() {
	let finish: (() => void) | undefined;
	const call: Caller = () => new Promise((resolve) => (finish = () => resolve({})));
	return { call, finish: () => finish?.(), reached: () => finish !== undefined };
}

describe('startManualVanSync', () => {
	it('runs the scheduled pass and frees the lock after', async () => {
		const { calls, call } = recorder();
		const result = await startManualVanSync(db, call);
		expect(result.status).toBe('started');
		await result.done;
		expect(calls).toEqual([{ campaign: '1', budget: 'long' }]);
		expect(await lockIsFree()).toBe(true);
	});

	// Turf cut since the first press started is in no catalog it read.
	it('folds a second press into the first, which reads VAN again', async () => {
		const releases: (() => void)[] = [];
		const call: Caller = () => new Promise((resolve) => releases.push(() => resolve({})));
		const first = await startManualVanSync(db, call, FAST);
		expect(first.status).toBe('started');
		await vi.waitFor(() => expect(releases).toHaveLength(1));
		const second = await startManualVanSync(db, call, FAST);
		expect(second.status).toBe('joined');
		releases[0]!();
		// A second pass, for the second press.
		await vi.waitFor(() => expect(releases).toHaveLength(2));
		releases[1]!();
		await first.done;
		await second.done;
		expect(releases).toHaveLength(2);
		expect(await lockIsFree()).toBe(true);
	});

	it('answers any number of presses during one pass with one more pass', async () => {
		const calls: string[] = [];
		let release: (() => void) | undefined;
		const call: Caller = async () => {
			calls.push('pass');
			if (calls.length === 1) await new Promise<void>((r) => (release = r));
			return {};
		};
		const first = await startManualVanSync(db, call, FAST);
		await vi.waitFor(() => expect(release).toBeDefined());
		const joined = [];
		for (let i = 0; i < 3; i++) {
			const press = await startManualVanSync(db, call, FAST);
			expect(press.status).toBe('joined');
			joined.push(press.done);
		}
		release!();
		await first.done;
		await Promise.all(joined);
		expect(calls).toEqual(['pass', 'pass']);
	});

	it('tells the after-pass to stop when a press asks for VAN again', async () => {
		const seen: boolean[] = [];
		const { call } = recorder();
		let pressed: Promise<void> | undefined;
		const first = await startManualVanSync(db, call, {
			...FAST,
			afterPass: async ({ shouldStop, deadline }) => {
				expect(deadline).toBeGreaterThan(Date.now());
				seen.push(await shouldStop());
				if (!pressed) {
					const press = await startManualVanSync(db, call, FAST);
					expect(press.status).toBe('joined');
					pressed = press.done;
					seen.push(await shouldStop());
				}
			},
		});
		await first.done;
		await pressed;
		// Clear, then asked; the next pass clears it before its after-pass.
		expect(seen).toEqual([false, true, false]);
	});

	// Bounded per run, but a press is never dropped: past the last pass a
	// fresh run takes the request up.
	it('hands a standing request to a fresh run after its last pass', async () => {
		const { calls, call } = recorder();
		const joined: Promise<void>[] = [];
		const first = await startManualVanSync(db, call, {
			...FAST,
			// A press during each of the first five after-passes.
			afterPass: async () => {
				if (joined.length >= 5) return;
				const press = await startManualVanSync(db, call, FAST);
				joined.push(press.done);
			},
		});
		await first.done;
		await Promise.all(joined);
		// Four passes, then a fresh run: one for the fifth press, one more for
		// the press made during it.
		expect(calls).toHaveLength(6);
		expect(await lockIsFree()).toBe(true);
	});

	// The holder's machine restarted mid-run: its lock lingers, nothing
	// heartbeats it, and nobody would answer the press waiting on it.
	it('takes over from a press that died holding the lock', async () => {
		const { calls, call } = recorder();
		await acquireSyncLock(db, MANUAL_VAN_SYNC_LOCK, 150);
		const press = await startManualVanSync(db, call, FAST);
		expect(press.status).toBe('joined');
		await press.done;
		expect(calls).toHaveLength(1);
		expect(await lockIsFree()).toBe(true);
	});

	it('leaves a live holder to answer the press itself', async () => {
		const releases: (() => void)[] = [];
		const call: Caller = () => new Promise((resolve) => releases.push(() => resolve({})));
		const first = await startManualVanSync(db, call, FAST);
		await vi.waitFor(() => expect(releases).toHaveLength(1));
		const press = await startManualVanSync(db, call, FAST);
		// The watcher sees the heartbeat and stands down while the pass runs on.
		await press.done;
		expect(releases).toHaveLength(1);
		releases[0]!();
		await vi.waitFor(() => expect(releases).toHaveLength(2));
		releases[1]!();
		await first.done;
	});

	// A request left by a press that crashed, or answered by the schedule, is
	// covered by the next press's own pass: it must not cost a second one.
	it('covers a leftover request with its own pass', async () => {
		const { calls, call } = recorder();
		await acquireSyncLock(db, MANUAL_VAN_RESYNC, MINUTE);
		const result = await startManualVanSync(db, call);
		await result.done;
		expect(calls).toHaveLength(1);
	});

	it('frees the lock when the pass fails', async () => {
		const call: Caller = async () => {
			throw new Error('HTTP 500');
		};
		const result = await startManualVanSync(db, call);
		await expect(result.done).resolves.toBeUndefined();
		expect(await lockIsFree()).toBe(true);
	});

	it('runs the after-pass step under its lock, after the pass, even when the pass fails', async () => {
		const order: string[] = [];
		const call: Caller = async () => {
			order.push('pass');
			throw new Error('HTTP 500');
		};
		const result = await startManualVanSync(db, call, {
			afterPass: async () => {
				order.push('after');
				// Still held: a second press waits for the shapes too.
				expect(await lockIsFree()).toBe(false);
			},
		});
		await result.done;
		expect(order).toEqual(['pass', 'after']);
		expect(await lockIsFree()).toBe(true);
	});

	it('frees the lock when the after-pass step fails', async () => {
		const { call } = recorder();
		const result = await startManualVanSync(db, call, {
			afterPass: async () => {
				throw new Error('VAN unreachable');
			},
		});
		await expect(result.done).resolves.toBeUndefined();
		expect(await lockIsFree()).toBe(true);
	});

	// Started at once, the endpoint would give up on the held campaign lock
	// and skip the catalog the organizer's new turf is in.
	it('waits for a sync already running, then runs', async () => {
		const scheduled = (await acquireSyncLock(db, vanSyncLock(1), 10 * MINUTE))!;
		const { calls, call } = recorder();
		const result = await startManualVanSync(db, call, { pollMs: 10 });
		expect(result.status).toBe('queued');
		await new Promise((r) => setTimeout(r, 50));
		expect(calls).toEqual([]);
		await releaseSyncLock(db, vanSyncLock(1), scheduled);
		await result.done;
		expect(calls).toEqual([{ campaign: '1', budget: 'long' }]);
	});

	// A scheduled pass syncs campaigns one after another. One look landing
	// between two of them must not count as finished.
	it('does not start in the gap between two campaigns of a running sync', async () => {
		const first = (await acquireSyncLock(db, vanSyncLock(1), 10 * MINUTE))!;
		const { calls, call } = recorder();
		// Looks land at ~100ms, ~200ms, …: the first sees the gap, the second
		// sees the next campaign. 50ms of margin either side of each.
		const result = await startManualVanSync(db, call, { pollMs: 100 });
		await releaseSyncLock(db, vanSyncLock(1), first);
		await new Promise((r) => setTimeout(r, 150));
		const second = (await acquireSyncLock(db, vanSyncLock(1), 10 * MINUTE))!;
		await new Promise((r) => setTimeout(r, 150));
		expect(calls).toEqual([]);
		await releaseSyncLock(db, vanSyncLock(1), second);
		await result.done;
		expect(calls).toEqual([{ campaign: '1', budget: 'long' }]);
	});

	// Each request expires claims and sends due reminders under the ledger
	// lock before it takes its campaign's: that stretch is a sync running too.
	it('waits while a sync holds only the ledger lock', async () => {
		const ledger = (await acquireSyncLock(db, VAN_LEDGER_LOCK, 10 * MINUTE))!;
		const { calls, call } = recorder();
		const result = await startManualVanSync(db, call, { pollMs: 10 });
		expect(result.status).toBe('queued');
		await new Promise((r) => setTimeout(r, 50));
		expect(calls).toEqual([]);
		await releaseSyncLock(db, VAN_LEDGER_LOCK, ledger);
		await result.done;
		expect(calls).toEqual([{ campaign: '1', budget: 'long' }]);
	});

	it('runs anyway once it has waited long enough', async () => {
		await acquireSyncLock(db, vanSyncLock(1), 10 * MINUTE);
		const { calls, call } = recorder();
		const result = await startManualVanSync(db, call, { pollMs: 10, maxWaitMs: 30 });
		await result.done;
		expect(calls).toEqual([{ campaign: '1', budget: 'long' }]);
	});

	it('ignores a disabled campaign’s lock', async () => {
		await client.execute(
			`INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (2, 'other', 0, 's', 's', 'x')`,
		);
		await acquireSyncLock(db, vanSyncLock(2), 10 * MINUTE);
		const result = await startManualVanSync(db, recorder().call);
		expect(result.status).toBe('started');
		await result.done;
	});

	// Short-lived so a crash frees it quickly, so a long pass has to keep it.
	it('keeps its lock alive while the pass runs', async () => {
		const pass = hanging();
		const result = await startManualVanSync(db, pass.call, { heartbeatMs: 20 });
		await vi.waitFor(() => expect(pass.reached()).toBe(true));
		const before = (await expiresAt())!;
		await vi.waitFor(async () => expect((await expiresAt())! > before).toBe(true), {
			timeout: 2000,
		});
		pass.finish();
		await result.done;
		expect(await lockIsFree()).toBe(true);
	});
});

describe('lastVanSyncs', () => {
	it('lists each enabled campaign, synced or not', async () => {
		await client.batch([
			"INSERT INTO van_sync_state (campaign_id, last_sync_at, last_error) VALUES (1, '2026-10-06T10:00:00.000Z', 'HTTP 401')",
			`INSERT INTO van_campaigns (id, credential_key, label, enabled, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (2, 'other', 'Partner', 1, 's', 's', 'x')`,
			`INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (3, 'off', 0, 's', 's', 'x')`,
			"INSERT INTO van_sync_state (campaign_id, last_sync_at) VALUES (3, '2026-10-06T11:00:00.000Z')",
		]);
		const syncs = await lastVanSyncs(db);
		expect(syncs).toEqual([
			{ id: 1, name: expect.any(String), lastSyncAt: '2026-10-06T10:00:00.000Z', failed: true },
			{ id: 2, name: 'Partner', lastSyncAt: null, failed: false },
		]);
	});
});

describe('failureReason', () => {
	it('takes the reason from a short answer', () => {
		expect(
			failureReason('/api/internal/van-sync answered 500: {"error":"SQLITE_BUSY"}', 'old'),
		).toBe('SQLITE_BUSY');
		expect(
			failureReason(
				'/api/internal/van-sync answered 500: {"campaigns":[{"campaignId":1,"error":"HTTP 401"}]}',
				'old',
			),
		).toBe('HTTP 401');
	});

	it('takes the campaign’s stored reason when the answer was cut short', () => {
		expect(
			failureReason('/api/internal/van-sync answered 500: {"expired":3,"campaig', 'HTTP 401'),
		).toBe('HTTP 401');
		expect(failureReason('/api/internal/van-sync answered 502: <html>', null)).toBe(
			'the sync request failed (HTTP 502)',
		);
	});

	it('says a timeout as it is, without the path', () => {
		expect(failureReason('/api/internal/van-sync took longer than 5 minutes', 'old')).toBe(
			'the sync request took longer than 5 minutes',
		);
	});
});

// What the page shows while a press runs and after (manual-sync-report.ts).
describe('the press record', () => {
	const PARTNER = `INSERT INTO van_campaigns (id, credential_key, label, enabled, last_edited_by, last_edited_by_name, last_edited_at)
		VALUES (2, 'other', 'Partner', 1, 's', 's', 'x')`;

	it('follows the press from reading VAN to done, naming who pressed', async () => {
		const pass = hanging();
		const phases: string[] = [];
		const result = await startManualVanSync(db, pass.call, {
			...FAST,
			startedByName: 'Alex',
			afterPass: async () => {
				phases.push((await latestManualVanSync(db))!.phase);
				return [{ campaignId: 1, attempted: 3, mapped: 2, stopped: 'out of time' }];
			},
		});
		await vi.waitFor(() => expect(pass.reached()).toBe(true));
		expect(await latestManualVanSync(db)).toMatchObject({
			phase: 'reading',
			passes: 1,
			startedByName: 'Alex',
			finishedAt: null,
			stalled: false,
		});
		pass.finish();
		await result.done;
		expect(phases).toEqual(['shapes']);
		expect(await latestManualVanSync(db)).toMatchObject({
			phase: 'done',
			finishedAt: expect.any(String),
			stalled: false,
			report: {
				campaigns: [{ campaignId: 1, outcome: 'synced', noRequestedFolder: true }],
				drain: [{ campaignId: 1, attempted: 3, mapped: 2, stopped: 'out of time' }],
			},
		});
	});

	it('starts out waiting behind a scheduled sync that is running', async () => {
		const held = (await acquireSyncLock(db, vanSyncLock(1), MINUTE))!;
		const { call } = recorder();
		const result = await startManualVanSync(db, call, { ...FAST, pollMs: 10 });
		expect(result.status).toBe('queued');
		expect((await latestManualVanSync(db))!.phase).toBe('waiting');
		await releaseSyncLock(db, vanSyncLock(1), held);
		await result.done;
		expect((await latestManualVanSync(db))!.phase).toBe('done');
	});

	// Why the organizer's turf did not come, campaign by campaign.
	it('records each campaign’s outcome, with a failure’s own reason', async () => {
		await client.batch([
			PARTNER,
			'UPDATE van_campaigns SET requested_folder_id = 900 WHERE id = 1',
			"INSERT INTO van_sync_state (campaign_id, last_error) VALUES (2, 'VAN rejected the API key')",
		]);
		const call: Caller = async (_path, params) => {
			if (params.campaign === '2') {
				throw new Error('/api/internal/van-sync answered 500: {"campaigns":[]}');
			}
			return { campaigns: [{ campaignId: 1, foldersSkipped: 2, newTurfsHeld: 3 }] };
		};
		await (
			await startManualVanSync(db, call, FAST)
		).done;
		const run = (await latestManualVanSync(db))!;
		expect(run.report!.campaigns).toEqual(
			expect.arrayContaining([
				{
					campaignId: 1,
					name: expect.any(String),
					outcome: 'synced',
					foldersSkipped: 2,
					newRoutesHeld: 3,
					noRequestedFolder: false,
				},
				{
					campaignId: 2,
					name: 'Partner',
					outcome: 'failed',
					error: 'VAN rejected the API key',
					noRequestedFolder: true,
				},
			]),
		);
	});

	it('says when another sync kept a campaign from being read', async () => {
		const call: Caller = async () => ({
			campaigns: [{ campaignId: 1, skipped: 'another catalog sync is in progress' }],
		});
		await (
			await startManualVanSync(db, call, FAST)
		).done;
		expect((await latestManualVanSync(db))!.report!.campaigns[0]).toMatchObject({
			outcome: 'skipped',
			error: 'another catalog sync is in progress',
		});
	});

	// The endpoint carries on after the press stops waiting for it.
	it('does not call a campaign the press stopped waiting on failed', async () => {
		const call: Caller = async () => {
			throw new Error('/api/internal/van-sync took longer than 10 minutes');
		};
		await (
			await startManualVanSync(db, call, FAST)
		).done;
		const [campaign] = (await latestManualVanSync(db))!.report!.campaigns;
		expect(campaign!.outcome).toBe('slow');
		expect(campaign!.error).toBeUndefined();
	});

	// Its machine stopped: nothing will finish the record.
	it('reads as stalled once nobody holds the press lock', async () => {
		await client.execute(
			"INSERT INTO van_manual_sync_runs (started_at, phase, passes) VALUES ('2026-10-23T10:00:00.000Z', 'shapes', 1)",
		);
		expect((await latestManualVanSync(db))!.stalled).toBe(true);
		const token = (await acquireSyncLock(db, MANUAL_VAN_SYNC_LOCK, MINUTE))!;
		expect((await latestManualVanSync(db))!.stalled).toBe(false);
		await releaseSyncLock(db, MANUAL_VAN_SYNC_LOCK, token);
	});

	// The turf an organizer moved into the folder keeps the firstSeenAt it
	// had; what was there when they pressed is what the page leaves out.
	it('remembers the requested turf already there when it was pressed', async () => {
		await client.batch([
			'UPDATE van_campaigns SET requested_folder_id = 900 WHERE id = 1',
			`INSERT INTO van_turfs (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id, name, first_seen_at, last_seen_at)
			 VALUES (500, 1, 500, 1, 900, 0, 'Already there', 'x', 'x'), (600, 1, 600, 1, 10, 0, 'Elsewhere', 'x', 'x')`,
		]);
		const call: Caller = async () => {
			// The press's pass moves 600 into the folder.
			await client.execute('UPDATE van_turfs SET folder_id = 900 WHERE turf_id = 600');
			return {};
		};
		await (
			await startManualVanSync(db, call, FAST)
		).done;
		expect((await latestManualVanSync(db))!.requestedTurfIds).toEqual([500]);
	});

	// A press past the last pass is answered by a fresh run of the same press,
	// so the page follows one press and counts from when it was pressed.
	it('keeps one record through a fresh run for presses past its last pass', async () => {
		const { calls, call } = recorder();
		const joined: Promise<void>[] = [];
		const seen: Array<{ finished: boolean; stalled: boolean }> = [];
		const first = await startManualVanSync(db, call, {
			...FAST,
			afterPass: async () => {
				const now = (await latestManualVanSync(db))!;
				seen.push({ finished: now.finishedAt !== null, stalled: now.stalled });
				if (joined.length >= 4) return;
				joined.push((await startManualVanSync(db, call, FAST)).done);
			},
		});
		await first.done;
		await Promise.all(joined);
		expect(calls).toHaveLength(5);
		const { rows } = await client.execute('SELECT count(*) AS n FROM van_manual_sync_runs');
		expect(rows[0]!.n).toBe(1);
		expect(await latestManualVanSync(db)).toMatchObject({ passes: 5, phase: 'done' });
		expect(seen.every((s) => !s.finished && !s.stalled)).toBe(true);
	});

	it('keeps only the last few runs', async () => {
		const { call } = recorder();
		for (let i = 0; i < 12; i++) await (await startManualVanSync(db, call, FAST)).done;
		const { rows } = await client.execute('SELECT count(*) AS n FROM van_manual_sync_runs');
		expect(rows[0]!.n).toBe(10);
	});
});

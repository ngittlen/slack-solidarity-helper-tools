import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { AttendeeSyncReport } from '../../../mobilize-migrator/lib/attendee-sync.js';
import type { MobilizeParticipation } from '../../../mobilize-migrator/lib/attendees.js';

vi.mock('./env.js', () => ({
	ATTENDEE_SYNC_MAX_NEW_PROFILES: 25,
	SOLIDARITY_DEFAULT_CHAPTER_ID: 0,
	SOLIDARITY_API_TOKEN: 't',
}));
vi.mock('./mobilize-api.js', () => ({ loadMobilizeApi: () => ({ apiKey: 'k', orgId: 7 }) }));
const fetchAllEvents = vi.hoisted(() => vi.fn());
vi.mock('../../../mobilize-migrator/lib/solidarity.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../mobilize-migrator/lib/solidarity.js')>()),
	fetchAllEvents,
}));
const fetchChangedParticipations = vi.hoisted(() => vi.fn());
vi.mock('../../../mobilize-migrator/lib/attendees.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../mobilize-migrator/lib/attendees.js')>()),
	fetchChangedParticipations,
}));
// The algorithm has its own tests; here, what the runner hands it and does
// with its report.
const runAttendeeSync = vi.hoisted(() => vi.fn());
// The zip map's rebuild: a walk of every Solidarity user.
const fetchPaginated = vi.hoisted(() => vi.fn(async () => []));
vi.mock('./solidarity-paginate.js', () => ({ fetchPaginated }));
vi.mock('./solidarity-walk-lock.js', () => ({
	withSolidarityWalkLock: <T>(walk: () => Promise<T>) => walk(),
}));
// The real handoff, watched, to see when the run takes from it.
const takeSolidarityEvents = vi.hoisted(() => vi.fn());
vi.mock('./solidarity-events-handoff.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./solidarity-events-handoff.js')>();
	takeSolidarityEvents.mockImplementation(actual.takeSolidarityEvents);
	return { ...actual, takeSolidarityEvents };
});
vi.mock('../../../mobilize-migrator/lib/attendee-sync.js', () => ({ runAttendeeSync }));

const { nextChangesState, readHeldStill, runSolidarityAttendeeSync } =
	await import('./attendee-sync.js');
const { handSolidarityEvents } = await import('./solidarity-events-handoff.js');

const NOW = new Date('2026-11-02T18:00:00.000Z');
const nowSeconds = NOW.getTime() / 1000;
const HOUR = 3600_000;

let client: ReturnType<typeof createClient>;
let db: ReturnType<typeof drizzle>;

/** A clean run's report: only the fields the runner reads matter. */
function report(over: Partial<AttendeeSyncReport> = {}): AttendeeSyncReport {
	return {
		incomplete: false,
		authFailed: false,
		eventsUnread: 0,
		retryEvents: [],
		...over,
	} as AttendeeSyncReport;
}

/** One Solidarity event with sessions `hours` from now, each paired with a
 *  Mobilize timeslot of the same number. */
async function sessionsIn(...hours: number[]) {
	fetchAllEvents.mockResolvedValue([
		{
			id: 1,
			title: 'Canvass',
			scope_type: 'Chapter',
			scope_id: 71,
			event_page_url: null,
			event_sessions: hours.map((h, i) => ({
				id: 100 + i,
				start_time: new Date(NOW.getTime() + h * HOUR).toISOString(),
				max_capacity: 0,
			})),
		},
	]);
	for (const [i] of hours.entries()) {
		await client.execute({
			sql: `INSERT INTO mobilize_synced_timeslots
			        (mobilize_timeslot_id, mobilize_event_id, solidarity_event_id, solidarity_session_id, updated_at)
			      VALUES (?, 9, 1, ?, 'x')`,
			args: [500 + i, 100 + i],
		});
	}
}

const storedChangesFrom = async () =>
	(await client.execute('SELECT changes_from FROM attendee_sync_state')).rows[0]?.changes_from ??
	null;
const storedRetries = async () =>
	JSON.parse(
		String(
			(await client.execute('SELECT retry_event_ids FROM attendee_sync_state')).rows[0]
				?.retry_event_ids ?? '[]',
		),
	);
const storedFullReadAt = async () =>
	(await client.execute('SELECT full_read_at FROM attendee_sync_state')).rows[0]?.full_read_at ??
	null;
/** A stored state, as of a nightly read `fullReadAgo` seconds back. */
const setChangesFrom = (seconds: number, retryEventIds = '[]', fullReadAgo = 3600) =>
	client.execute({
		sql: "INSERT INTO attendee_sync_state (id, changes_from, retry_event_ids, full_read_at, updated_at) VALUES (1, ?, ?, ?, 'x')",
		args: [seconds, retryEventIds, nowSeconds - fullReadAgo],
	});
const linksGiven = () =>
	(runAttendeeSync.mock.calls[0]![0] as Array<{ mobilizeTimeslotId: number }>).map(
		(l) => l.mobilizeTimeslotId,
	);
const configGiven = () =>
	runAttendeeSync.mock.calls[0]![1] as {
		changed?: MobilizeParticipation[];
		retryEvents?: number[];
		unlinkedTimeslots?: Map<number, number>;
		windowEnd?: number;
	};

beforeEach(async () => {
	vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	// A fresh zip map, so no run walks Solidarity's users to rebuild it.
	await client.execute({
		sql: "INSERT INTO zip_chapter_map (zip_code, chapter_id, member_count, updated_at) VALUES ('48104', 71, 3, ?)",
		args: [NOW.toISOString()],
	});
	runAttendeeSync.mockResolvedValue(report());
	fetchChangedParticipations.mockResolvedValue([]);
	await sessionsIn(1, 30);
});

afterEach(() => {
	client.close();
	vi.useRealTimers();
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe('runSolidarityAttendeeSync: which signups it reads', () => {
	it('reads only the changes, on every upcoming shift, once a run has stored where to start', async () => {
		await setChangesFrom(nowSeconds - 1800);

		const result = await runSolidarityAttendeeSync(db, { windowHours: 4.5 });

		// From a little before the stored start: the clocks may disagree.
		expect(fetchChangedParticipations.mock.calls[0]![0]).toBe(nowSeconds - 1800 - 600);
		expect(configGiven().changed).toEqual([]);
		// The shift 30 hours out too: a signup on it may change before the
		// window reaches it, and no later read of changes would see it again.
		expect(linksGiven()).toEqual([500, 501]);
		// The cap check stays on the window's shifts.
		expect(configGiven().windowEnd).toBe(NOW.getTime() + 4.5 * HOUR);
		expect(result.changedSince).toBe(nowSeconds - 1800 - 600);
	});

	it('reads every event in the window when no run has stored a start', async () => {
		await runSolidarityAttendeeSync(db, { windowHours: 4.5 });

		expect(fetchChangedParticipations).not.toHaveBeenCalled();
		expect(configGiven().changed).toBeUndefined();
		expect(linksGiven()).toEqual([500]);
	});

	// The half-hourly runs store a start too, so the nightly read's own time
	// is what says it has stopped.
	it('reads every event in the window, and says why, when the nightly read has stopped', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await setChangesFrom(nowSeconds - 1800, '[]', 31 * 3600);

		const result = await runSolidarityAttendeeSync(db, { windowHours: 4.5 });

		expect(fetchChangedParticipations).not.toHaveBeenCalled();
		expect(linksGiven()).toEqual([500]);
		expect(result.changedSince).toBeNull();
		expect(String(warn.mock.calls[0]![0])).toContain('no nightly read of every event since');
	});

	it('reads every event in the window when the state cannot be read', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		await client.execute('DROP TABLE attendee_sync_state');

		await runSolidarityAttendeeSync(db, { windowHours: 4.5 });

		expect(fetchChangedParticipations).not.toHaveBeenCalled();
		expect(linksGiven()).toEqual([500]);
		expect(error).toHaveBeenCalled();
	});

	it('names the paired timeslots whose session Solidarity did not list', async () => {
		await setChangesFrom(nowSeconds - 1800);
		await client.execute(
			"INSERT INTO mobilize_synced_timeslots (mobilize_timeslot_id, mobilize_event_id, solidarity_event_id, solidarity_session_id, updated_at) VALUES (777, 33, 1, 9999, 'x')",
		);

		await runSolidarityAttendeeSync(db, { windowHours: 4.5 });

		expect([...configGiven().unlinkedTimeslots!]).toEqual([[777, 33]]);
	});

	it('reads every event in the window when the read of changes fails', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await setChangesFrom(nowSeconds - 1800);
		fetchChangedParticipations.mockRejectedValue(new Error('429'));

		const result = await runSolidarityAttendeeSync(db, { windowHours: 4.5 });

		expect(configGiven().changed).toBeUndefined();
		expect(linksGiven()).toEqual([500]);
		expect(result.changedSince).toBeNull();
		// The window's read leaves later shifts out, so the stored start stands.
		expect(await storedChangesFrom()).toBe(nowSeconds - 1800);
	});

	it('reads every event on the nightly run, whatever is stored', async () => {
		await setChangesFrom(nowSeconds - 1800);

		await runSolidarityAttendeeSync(db, {});

		expect(fetchChangedParticipations).not.toHaveBeenCalled();
		expect(linksGiven()).toEqual([500, 501]);
	});
});

describe('runSolidarityAttendeeSync: where the next read of changes starts', () => {
	it('stores when the nightly run began reading, and that it read every event', async () => {
		await runSolidarityAttendeeSync(db, {});
		expect(await storedChangesFrom()).toBe(nowSeconds);
		expect(await storedFullReadAt()).toBe(nowSeconds);
	});

	it('moves it forward after a clean read of changes, keeping the nightly read’s time', async () => {
		await setChangesFrom(nowSeconds - 1800);
		await runSolidarityAttendeeSync(db, { windowHours: 4.5 });
		expect(await storedChangesFrom()).toBe(nowSeconds);
		expect(await storedFullReadAt()).toBe(nowSeconds - 3600);
	});

	// Changed signups on sessions it did not look back to are dropped.
	it('leaves it after a run that looks back less than usual', async () => {
		await runSolidarityAttendeeSync(db, { lookbackHours: 1 });
		expect(await storedChangesFrom()).toBeNull();
	});

	it('logs, and does not throw, when it cannot store it', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		runAttendeeSync.mockImplementation(async () => {
			await client.execute('DROP TABLE attendee_sync_state');
			return report();
		});

		await expect(runSolidarityAttendeeSync(db, {})).resolves.toMatchObject({ dryRun: false });
		expect(String(error.mock.calls[0]![0])).toContain('could not store');
	});

	// A signup that fails every run costs its event's read each run, and
	// never holds the read of changes back.
	it('passes on the events of failed signups, and moves forward all the same', async () => {
		await setChangesFrom(nowSeconds - 1800, '[42]');
		runAttendeeSync.mockResolvedValue(report({ failed: 1, retryEvents: [42, 43] }));

		await runSolidarityAttendeeSync(db, { windowHours: 4.5 });

		expect(configGiven().retryEvents).toEqual([42]);
		expect(await storedChangesFrom()).toBe(nowSeconds);
		expect(await storedRetries()).toEqual([42, 43]);
	});

	it('reads no retries from a list it cannot parse', async () => {
		await setChangesFrom(nowSeconds - 1800, 'not json');
		await runSolidarityAttendeeSync(db, { windowHours: 4.5 });
		expect(configGiven().retryEvents).toEqual([]);
	});

	it('leaves it after a windowed read of every event', async () => {
		await runSolidarityAttendeeSync(db, { windowHours: 4.5 });
		expect(await storedChangesFrom()).toBeNull();
	});

	it('leaves it on a dry run', async () => {
		await runSolidarityAttendeeSync(db, { apply: false });
		expect(await storedChangesFrom()).toBeNull();
	});
});

describe('readHeldStill', () => {
	it('trusts a read with nothing changed near its start', () => {
		expect(readHeldStill([{ modifiedDate: 1000 - 601 }], 1000)).toBe(true);
		expect(readHeldStill([], 1000)).toBe(true);
		expect(readHeldStill(undefined, 1000)).toBe(true);
	});

	// Within the clocks' disagreement of its start: it may have moved in the
	// list while the pages were read, and pushed another past them.
	it('does not trust one with a signup changed as it was read', () => {
		expect(readHeldStill([{ modifiedDate: 1000 - 600 }], 1000)).toBe(false);
		expect(readHeldStill([{ modifiedDate: 1005 }], 1000)).toBe(false);
	});
});

describe('runSolidarityAttendeeSync: a read of changes that moved as it was read', () => {
	it('keeps the stored start, and says so', async () => {
		await setChangesFrom(nowSeconds - 1800);
		fetchChangedParticipations.mockResolvedValue([
			{ id: 1, timeslotId: 500, modifiedDate: nowSeconds },
		]);

		const result = await runSolidarityAttendeeSync(db, { windowHours: 4.5 });

		expect(result.changesHeld).toBe(true);
		expect(await storedChangesFrom()).toBe(nowSeconds - 1800);
	});
});

describe('nextChangesState', () => {
	const scope = (over: Partial<Parameters<typeof nextChangesState>[1]> = {}) => ({
		readFrom: 1000,
		allUpcoming: true,
		fullRead: false,
		fullLookback: true,
		readSettled: true,
		...over,
	});
	const stored = { changesFrom: 500, retryEventIds: [1], fullReadAt: 400 };

	it('starts when the run began reading, after a clean run over every upcoming shift', () => {
		expect(nextChangesState(report(), scope(), stored)).toEqual({
			changesFrom: 1000,
			retryEventIds: [],
			fullReadAt: 400,
		});
	});

	it('records a read of every event as the nightly read', () => {
		expect(nextChangesState(report(), scope({ fullRead: true }), null)?.fullReadAt).toBe(1000);
	});

	// Events it could not read, or had a signup on it could not write, go on
	// the list; neither holds the read of changes back.
	it('carries the events to read whole', () => {
		expect(
			nextChangesState(report({ retryEvents: [7], eventsUnread: 1 }), scope(), stored),
		).toEqual({ changesFrom: 1000, retryEventIds: [7], fullReadAt: 400 });
	});

	it('moves nothing when the run left signups unsettled', () => {
		expect(nextChangesState(report(), scope({ allUpcoming: false }), stored)).toBeNull();
		expect(nextChangesState(report(), scope({ fullLookback: false }), stored)).toBeNull();
		expect(nextChangesState(report(), scope({ readSettled: false }), stored)).toBeNull();
		expect(nextChangesState(report({ incomplete: true }), scope(), stored)).toBeNull();
		expect(nextChangesState(report({ authFailed: true }), scope(), stored)).toBeNull();
		expect(nextChangesState(report({ abortedReason: 'too many' }), scope(), stored)).toBeNull();
	});
});

describe('runSolidarityAttendeeSync: Solidarity events', () => {
	it('takes the Mobilize sync’s read when it has just made one', async () => {
		const handed = [{ id: 2, event_sessions: [] }] as never;
		handSolidarityEvents(handed);

		await runSolidarityAttendeeSync(db, {});

		expect(fetchAllEvents).not.toHaveBeenCalled();
	});

	// The zip map's rebuild walks every Solidarity user for minutes first.
	it('takes the handed read before rebuilding the zip map', async () => {
		await client.execute('DELETE FROM zip_chapter_map');
		const order: string[] = [];
		takeSolidarityEvents.mockImplementationOnce(() => {
			order.push('take');
			return null;
		});
		fetchPaginated.mockImplementationOnce(async () => {
			order.push('rebuild');
			return [];
		});

		await runSolidarityAttendeeSync(db, {});

		expect(order).toEqual(['take', 'rebuild']);
	});

	// Taken before the rebuild, used after it: by then it may be too old.
	it('reads them itself when the handed read has gone stale by its use', async () => {
		takeSolidarityEvents.mockImplementationOnce(() => ({
			at: NOW.getTime() - 11 * 60_000,
			events: [],
		}));

		await runSolidarityAttendeeSync(db, {});

		expect(fetchAllEvents).toHaveBeenCalledOnce();
	});

	it('reads them itself otherwise', async () => {
		await runSolidarityAttendeeSync(db, {});
		expect(fetchAllEvents).toHaveBeenCalledOnce();
	});
});

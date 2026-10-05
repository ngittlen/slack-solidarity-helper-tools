import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
	clearGoogleVolunteers,
	googleBlockTargetName,
	loadBlockableGoogleVolunteers,
	loadGoogleVolunteer,
	loadGoogleVolunteers,
	loadHolderAccounts,
	recordGoogleSignIn,
} from './google-volunteers.js';

// A real in-memory libsql built from the real migrations, so the queries run
// against the tables they will actually meet.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

const FIRST = new Date('2026-10-01T12:00:00Z');
const LATER = new Date('2026-10-03T09:00:00Z');

describe('recordGoogleSignIn', () => {
	it('stores a first sign-in', async () => {
		await recordGoogleSignIn(
			db,
			{ userId: 'google:1', email: 'ana@example.com', displayName: 'Ana' },
			FIRST,
		);
		expect(await loadGoogleVolunteer(db, 'google:1')).toEqual({
			userId: 'google:1',
			email: 'ana@example.com',
			displayName: 'Ana',
			firstSignedInAt: FIRST.toISOString(),
			lastSignedInAt: FIRST.toISOString(),
		});
	});

	it('refreshes email, name and last sign-in, keeping the first', async () => {
		await recordGoogleSignIn(
			db,
			{ userId: 'google:1', email: 'ana@example.com', displayName: 'Ana' },
			FIRST,
		);
		await recordGoogleSignIn(
			db,
			{ userId: 'google:1', email: 'ana@new.example', displayName: 'Ana Ruiz' },
			LATER,
		);
		expect(await loadGoogleVolunteer(db, 'google:1')).toMatchObject({
			email: 'ana@new.example',
			displayName: 'Ana Ruiz',
			firstSignedInAt: FIRST.toISOString(),
			lastSignedInAt: LATER.toISOString(),
		});
	});
});

describe('loadGoogleVolunteers', () => {
	it('lists everyone by name', async () => {
		await recordGoogleSignIn(db, { userId: 'google:2', email: 'z@x.org', displayName: 'Zed' });
		await recordGoogleSignIn(db, { userId: 'google:1', email: 'a@x.org', displayName: 'Ana' });
		expect((await loadGoogleVolunteers(db)).map((v) => v.displayName)).toEqual(['Ana', 'Zed']);
	});
});

describe('clearGoogleVolunteers', () => {
	it('deletes every record and says how many', async () => {
		await recordGoogleSignIn(db, { userId: 'google:1', email: 'a@x.org', displayName: 'Ana' });
		await recordGoogleSignIn(db, { userId: 'google:2', email: 'z@x.org', displayName: 'Zed' });
		expect(await clearGoogleVolunteers(db)).toBe(2);
		expect(await loadGoogleVolunteers(db)).toEqual([]);
		expect(await clearGoogleVolunteers(db)).toBe(0);
	});

	it('clears nothing when part of it fails', async () => {
		await recordGoogleSignIn(db, { userId: 'google:1', email: 'a@x.org', displayName: 'Ana' });
		await client.execute('DROP TABLE turf_notices');
		await expect(clearGoogleVolunteers(db)).rejects.toThrow();
		expect(await loadGoogleVolunteers(db)).toHaveLength(1);
	});

	// The campaign is over, and some of these name a MiniVAN list number.
	it('clears the turf messages kept for Google volunteers too', async () => {
		await client.execute(
			"INSERT INTO turf_notices (user_id, kind, text, created_at) VALUES ('google:1', 'list-number', 'New list number: *L1*', '2026-10-01T00:00:00Z')",
		);
		await clearGoogleVolunteers(db);
		const left = await client.execute('SELECT count(*) AS n FROM turf_notices');
		expect(Number(left.rows[0]!.n)).toBe(0);
	});
});

describe('loadHolderAccounts', () => {
	it('marks Slack and Google holders, with Google emails', async () => {
		await recordGoogleSignIn(db, { userId: 'google:1', email: 'a@x.org', displayName: 'Ana' });
		const accounts = await loadHolderAccounts(db, ['U123', 'google:1', 'U123']);
		expect(Object.fromEntries(accounts)).toEqual({
			U123: { provider: 'slack', email: null },
			'google:1': { provider: 'google', email: 'a@x.org' },
		});
	});

	it('still marks a Google holder whose record was cleared, without an email', async () => {
		const accounts = await loadHolderAccounts(db, ['google:9']);
		expect(accounts.get('google:9')).toEqual({ provider: 'google', email: null });
	});

	it('degrades to no emails rather than throwing when the read fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		client.close();
		const accounts = await loadHolderAccounts(db, ['google:1', 'U1']);
		expect(accounts.get('google:1')).toEqual({ provider: 'google', email: null });
		expect(accounts.get('U1')).toEqual({ provider: 'slack', email: null });
	});

	it('skips the read entirely when nobody signed in with Google', async () => {
		client.close();
		const accounts = await loadHolderAccounts(db, ['U1']);
		expect(accounts.get('U1')).toEqual({ provider: 'slack', email: null });
	});
});

/** A claim by `holder`, live unless `released`. Each on its own turf: the
 *  ledger allows one live claim per turf. */
let nextTurf = 100;
async function claim(holder: string, name: string, claimedAt: string, released = false) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at, released_at)
		      VALUES (?, ?, ?, ?, '2026-10-09T00:00:00Z', ?)`,
		args: [nextTurf++, holder, name, claimedAt, released ? '2026-10-04T00:00:00Z' : null],
	});
}

// A record can be gone while its owner still holds turf: cleared by an admin
// mid-campaign, or never written. Blocking has to work then most of all.
describe('loadBlockableGoogleVolunteers', () => {
	it('offers everyone with a record, plus Google holders without one', async () => {
		await recordGoogleSignIn(db, { userId: 'google:1', email: 'a@x.org', displayName: 'Ana' });
		await claim('google:1', 'Ana', '2026-10-03T10:00:00Z');
		await claim('google:9', 'Zed', '2026-10-03T11:00:00Z');
		await claim('U1', 'Slack Sam', '2026-10-03T11:00:00Z');
		// No live claim, no record: nothing to offer.
		await claim('google:8', 'Gone', '2026-10-01T10:00:00Z', true);

		expect(await loadBlockableGoogleVolunteers(db)).toEqual([
			{ userId: 'google:1', displayName: 'Ana', email: 'a@x.org' },
			{ userId: 'google:9', displayName: 'Zed', email: null },
		]);
	});
});

describe('googleBlockTargetName', () => {
	it("uses the record's name when there is one", async () => {
		await recordGoogleSignIn(db, { userId: 'google:1', email: 'a@x.org', displayName: 'Ana' });
		await claim('google:1', 'Old Name', '2026-10-03T10:00:00Z');
		expect(await googleBlockTargetName(db, 'google:1')).toBe('Ana');
	});

	it('falls back to the newest claim when the record is gone', async () => {
		await claim('google:9', 'Zed Older', '2026-10-01T10:00:00Z', true);
		await claim('google:9', 'Zed', '2026-10-03T10:00:00Z');
		expect(await googleBlockTargetName(db, 'google:9')).toBe('Zed');
	});

	it('is null for an id that has never signed in or held turf', async () => {
		expect(await googleBlockTargetName(db, 'google:404')).toBeNull();
	});
});

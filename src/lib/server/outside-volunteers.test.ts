import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
	clearOutsideVolunteers,
	countOutsideVolunteers,
	loadBlockableOutsideVolunteers,
	loadHolderAccounts,
	loadOutsideVolunteer,
	outsideBlockTargetName,
	recordOutsideSignIn,
	setDisplayNameOnce,
} from './outside-volunteers.js';

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

/** A Google sign-in, the shape most of these tests need. */
function google(userId: string, email: string, displayName: string | null, now?: Date) {
	return recordOutsideSignIn(
		db,
		{ userId, provider: 'google', email, isPrivateEmail: false, displayName },
		now,
	);
}

function apple(userId: string, displayName: string | null, now?: Date) {
	return recordOutsideSignIn(
		db,
		{
			userId,
			provider: 'apple',
			email: 'x1y2@privaterelay.appleid.com',
			isPrivateEmail: true,
			displayName,
		},
		now,
	);
}

const FIRST = new Date('2026-10-01T12:00:00Z');
const LATER = new Date('2026-10-03T09:00:00Z');

describe('recordOutsideSignIn', () => {
	it('stores a first sign-in', async () => {
		await google('google:1', 'ana@example.com', 'Ana', FIRST);
		expect(await loadOutsideVolunteer(db, 'google:1')).toEqual({
			userId: 'google:1',
			provider: 'google',
			email: 'ana@example.com',
			isPrivateEmail: false,
			displayName: 'Ana',
			firstSignedInAt: FIRST.toISOString(),
			lastSignedInAt: FIRST.toISOString(),
		});
	});

	it('refreshes email, name and last sign-in, keeping the first', async () => {
		await google('google:1', 'ana@example.com', 'Ana', FIRST);
		await google('google:1', 'ana@new.example', 'Ana Ruiz', LATER);
		expect(await loadOutsideVolunteer(db, 'google:1')).toMatchObject({
			email: 'ana@new.example',
			displayName: 'Ana Ruiz',
			firstSignedInAt: FIRST.toISOString(),
			lastSignedInAt: LATER.toISOString(),
		});
	});
});

describe('countOutsideVolunteers', () => {
	it('counts each provider', async () => {
		await google('google:1', 'a@x.org', 'Ana');
		await google('google:2', 'z@x.org', 'Zed');
		await apple('apple:1', 'Bo');
		expect(await countOutsideVolunteers(db)).toEqual({ google: 2, apple: 1 });
	});

	it('is zero for both with nobody signed in', async () => {
		expect(await countOutsideVolunteers(db)).toEqual({ google: 0, apple: 0 });
	});
});

describe('clearOutsideVolunteers', () => {
	it('deletes every record and says how many', async () => {
		await google('google:1', 'a@x.org', 'Ana');
		await google('google:2', 'z@x.org', 'Zed');
		await apple('apple:1', 'Bo');
		expect(await clearOutsideVolunteers(db)).toBe(3);
		expect(await countOutsideVolunteers(db)).toEqual({ google: 0, apple: 0 });
		expect(await clearOutsideVolunteers(db)).toBe(0);
	});

	it('clears nothing when part of it fails', async () => {
		await google('google:1', 'a@x.org', 'Ana');
		await client.execute('DROP TABLE turf_notices');
		await expect(clearOutsideVolunteers(db)).rejects.toThrow();
		expect(await countOutsideVolunteers(db)).toEqual({ google: 1, apple: 0 });
	});

	// Still holds the rows 0063 copied, emails and all, until it is dropped.
	it('empties the retired google_volunteers table too', async () => {
		await client.execute(
			"INSERT INTO google_volunteers VALUES ('google:1', 'a@x.org', 'Ana', '2026-10-01', '2026-10-02')",
		);
		await clearOutsideVolunteers(db);
		const left = await client.execute('SELECT count(*) AS n FROM google_volunteers');
		expect(Number(left.rows[0]!.n)).toBe(0);
	});

	// The campaign is over, and some of these name a MiniVAN list number.
	it('clears the turf messages kept for Google and Apple volunteers too', async () => {
		for (const id of ['google:1', 'apple:1']) {
			await client.execute({
				sql: "INSERT INTO turf_notices (user_id, kind, text, created_at) VALUES (?, 'list-number', 'New list number: *L1*', '2026-10-01T00:00:00Z')",
				args: [id],
			});
		}
		await clearOutsideVolunteers(db);
		const left = await client.execute('SELECT count(*) AS n FROM turf_notices');
		expect(Number(left.rows[0]!.n)).toBe(0);
	});
});

describe('loadHolderAccounts', () => {
	it('marks Slack, Google and Apple holders, with outside emails', async () => {
		await google('google:1', 'a@x.org', 'Ana');
		await apple('apple:1', 'Bo');
		const accounts = await loadHolderAccounts(db, ['U123', 'google:1', 'U123', 'apple:1']);
		expect(Object.fromEntries(accounts)).toEqual({
			U123: { provider: 'slack', email: null, isPrivateEmail: false },
			'google:1': { provider: 'google', email: 'a@x.org', isPrivateEmail: false },
			'apple:1': {
				provider: 'apple',
				email: 'x1y2@privaterelay.appleid.com',
				isPrivateEmail: true,
			},
		});
	});

	it('still marks a Google holder whose record was cleared, without an email', async () => {
		const accounts = await loadHolderAccounts(db, ['google:9']);
		expect(accounts.get('google:9')).toEqual({
			provider: 'google',
			email: null,
			isPrivateEmail: false,
		});
	});

	it('degrades to no emails rather than throwing when the read fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		client.close();
		const accounts = await loadHolderAccounts(db, ['google:1', 'U1']);
		expect(accounts.get('google:1')).toEqual({
			provider: 'google',
			email: null,
			isPrivateEmail: false,
		});
		expect(accounts.get('U1')).toEqual({ provider: 'slack', email: null, isPrivateEmail: false });
	});

	it('skips the read entirely when every holder is a Slack member', async () => {
		client.close();
		const accounts = await loadHolderAccounts(db, ['U1']);
		expect(accounts.get('U1')).toEqual({ provider: 'slack', email: null, isPrivateEmail: false });
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
describe('loadBlockableOutsideVolunteers', () => {
	it('offers everyone with a record, plus outside holders without one', async () => {
		await google('google:1', 'a@x.org', 'Ana');
		await apple('apple:2', null);
		await claim('google:1', 'Ana', '2026-10-03T10:00:00Z');
		await claim('google:9', 'Zed', '2026-10-03T11:00:00Z');
		await claim('apple:9', 'Yan', '2026-10-03T11:00:00Z');
		await claim('U1', 'Slack Sam', '2026-10-03T11:00:00Z');
		// No live claim, no record: nothing to offer.
		await claim('google:8', 'Gone', '2026-10-01T10:00:00Z', true);

		expect(await loadBlockableOutsideVolunteers(db)).toEqual([
			{
				userId: 'google:1',
				provider: 'google',
				displayName: 'Ana',
				email: 'a@x.org',
				isPrivateEmail: false,
			},
			{
				userId: 'apple:2',
				provider: 'apple',
				displayName: 'Unnamed Apple volunteer',
				email: 'x1y2@privaterelay.appleid.com',
				isPrivateEmail: true,
			},
			{
				userId: 'apple:9',
				provider: 'apple',
				displayName: 'Yan',
				email: null,
				isPrivateEmail: false,
			},
			{
				userId: 'google:9',
				provider: 'google',
				displayName: 'Zed',
				email: null,
				isPrivateEmail: false,
			},
		]);
	});
});

describe('outsideBlockTargetName', () => {
	it("uses the record's name when there is one", async () => {
		await google('google:1', 'a@x.org', 'Ana');
		await claim('google:1', 'Old Name', '2026-10-03T10:00:00Z');
		expect(await outsideBlockTargetName(db, 'google:1')).toBe('Ana');
	});

	it('falls back to the newest claim when the record is gone', async () => {
		await claim('google:9', 'Zed Older', '2026-10-01T10:00:00Z', true);
		await claim('google:9', 'Zed', '2026-10-03T10:00:00Z');
		expect(await outsideBlockTargetName(db, 'google:9')).toBe('Zed');
	});

	it('is null for an id that has never signed in or held turf', async () => {
		expect(await outsideBlockTargetName(db, 'google:404')).toBeNull();
	});
});

describe('names across sign-ins', () => {
	it('lets a Google profile name refresh the stored one', async () => {
		await google('google:1', 'a@x.org', 'Ana', FIRST);
		expect(await google('google:1', 'a@x.org', 'Ana Ruiz', LATER)).toBe('Ana Ruiz');
	});

	it('keeps a stored name when a Google profile now has none', async () => {
		await google('google:1', 'a@x.org', 'Ana', FIRST);
		expect(await google('google:1', 'a@x.org', null, LATER)).toBe('Ana');
	});

	it('keeps the first Apple name over anything sent later', async () => {
		await apple('apple:1', 'Bo', FIRST);
		expect(await apple('apple:1', null, LATER)).toBe('Bo');
		expect(await apple('apple:1', 'Robert', LATER)).toBe('Bo');
	});

	it('stores an Apple name sent after a nameless first sign-in', async () => {
		await apple('apple:1', null, FIRST);
		expect(await apple('apple:1', 'Bo', LATER)).toBe('Bo');
	});

	it('returns null for someone who has never had a name', async () => {
		expect(await apple('apple:1', null)).toBeNull();
	});
});

describe('setDisplayNameOnce', () => {
	it('saves a name on a record that has none', async () => {
		await apple('apple:1', null);
		expect(await setDisplayNameOnce(db, 'apple:1', 'Bo')).toEqual({ status: 'saved' });
		expect((await loadOutsideVolunteer(db, 'apple:1'))?.displayName).toBe('Bo');
	});

	it('refuses a second name, returning the first', async () => {
		await apple('apple:1', null);
		await setDisplayNameOnce(db, 'apple:1', 'Bo');
		expect(await setDisplayNameOnce(db, 'apple:1', 'Robert')).toEqual({
			status: 'taken',
			displayName: 'Bo',
		});
		expect((await loadOutsideVolunteer(db, 'apple:1'))?.displayName).toBe('Bo');
	});

	it('says when there is no record to write to', async () => {
		expect(await setDisplayNameOnce(db, 'apple:404', 'Bo')).toEqual({ status: 'no-record' });
	});
});

import { describe, afterEach, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { vanTurfs } from '../schema.js';
import { gatedByFreshTurf } from './fresh-nearby.js';
import { claimTurf } from './checkout-store.js';

// A real in-memory libsql: the box read on the centroid columns is half of
// what is under test, and a fake would only echo back what it was told.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-10-16T18:00:00.000Z');
const LIVE_UNTIL = '2026-10-17T18:00:00.000Z';
const HOME = { lat: 42.28, lng: -83.74 };
/** Degrees of latitude in `miles`, near enough for a test. */
const north = (miles: number) => HOME.lat + miles / 69.05;

const STRIPED = 1;
const FRESH = 2;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterEach(() => {
	client.close();
});

async function insertTurf(
	turfId: number,
	over: {
		lat?: number | null;
		lng?: number | null;
		knockedBeforeCut?: number;
		listNumber?: string | null;
		hidden?: boolean;
		doorCount?: number;
	} = {},
) {
	const knocked = over.knockedBeforeCut ?? 0;
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (turf_id, van_map_route_id, map_region_id, folder_id, chapter_id, chapter_name,
		         region_name, name, printed_list_number, door_count, centroid_lat, centroid_lng,
		         saved_list_id, roster_saved_list_id, uncontacted_doors, knocked_before_cut,
		         hidden_at, first_seen_at, last_seen_at)
		      VALUES (?, ?, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', ?, ?, ?, ?, ?, 5, 5, ?, ?, ?, ?, ?)`,
		args: [
			turfId,
			turfId,
			`Turf ${turfId}`,
			over.listNumber === undefined ? `L-${turfId}` : over.listNumber,
			over.doorCount ?? 100,
			over.lat === undefined ? HOME.lat : over.lat,
			over.lng === undefined ? HOME.lng : over.lng,
			over.doorCount ?? 100,
			knocked,
			over.hidden ? NOW.toISOString() : null,
			NOW.toISOString(),
			NOW.toISOString(),
		],
	});
}

async function striped() {
	await insertTurf(STRIPED, { knockedBeforeCut: 30 });
}

const ME = 'U_ME';

async function gated(turfIds = [STRIPED], viewer = ME) {
	const rows = await db.select().from(vanTurfs);
	return gatedByFreshTurf(
		db,
		rows.filter((r) => turfIds.includes(r.turfId)),
		viewer,
		NOW,
	);
}

async function claim(
	turfId: number,
	over: {
		slackUserId?: string;
		claimedAt?: string;
		releasedAt?: string;
		completedAt?: string;
		percent?: number;
	} = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at, released_at,
		         completed_at, reported_percent)
		      VALUES (?, ?, 'Dana', ?, ?, ?, ?, ?)`,
		args: [
			turfId,
			over.slackUserId ?? 'U_OTHER',
			over.claimedAt ?? '2026-10-16T12:00:00.000Z',
			LIVE_UNTIL,
			over.releasedAt ?? null,
			over.completedAt ?? null,
			over.percent ?? null,
		],
	});
}

describe('gatedByFreshTurf', () => {
	it('holds back striped turf with free fresh turf a mile away', async () => {
		await striped();
		await insertTurf(FRESH, { lat: north(1) });
		expect(await gated()).toEqual(new Set([STRIPED]));
	});

	it('lets it go when the fresh turf is past the radius', async () => {
		await striped();
		await insertTurf(FRESH, { lat: north(3) });
		expect(await gated()).toEqual(new Set());
	});

	it('does not count another striped turf as fresh', async () => {
		await striped();
		await insertTurf(FRESH, { lat: north(1), knockedBeforeCut: 5 });
		expect(await gated()).toEqual(new Set());
	});

	it('does not count fresh turf nobody could take', async () => {
		await striped();
		await insertTurf(FRESH, { lat: north(1) });
		await claim(FRESH);
		expect(await gated()).toEqual(new Set());
	});

	it('does not count fresh turf someone just walked', async () => {
		await striped();
		await insertTurf(FRESH, { lat: north(1) });
		await claim(FRESH, { completedAt: '2026-10-16T17:00:00.000Z', percent: 40 });
		expect(await gated()).toEqual(new Set());
	});

	it.each([
		['hidden', { hidden: true }],
		['without a list number', { listNumber: null }],
		['with no doors left', { doorCount: 0 }],
	])('does not count fresh turf %s', async (_label, over) => {
		await striped();
		await insertTurf(FRESH, { lat: north(1), ...over });
		expect(await gated()).toEqual(new Set());
	});

	it('does not count fresh turf in a disabled campaign', async () => {
		await striped();
		await insertTurf(FRESH, { lat: north(1) });
		await client.execute('UPDATE van_campaigns SET enabled = 0');
		expect(await gated()).toEqual(new Set());
	});

	it('never holds back turf with no centroid', async () => {
		await insertTurf(STRIPED, { knockedBeforeCut: 30, lat: null, lng: null });
		await insertTurf(FRESH, { lat: north(1) });
		expect(await gated()).toEqual(new Set());
	});

	it('leaves fresh turf alone', async () => {
		await striped();
		await insertTurf(FRESH, { lat: north(1) });
		expect(await gated([FRESH])).toEqual(new Set());
	});

	describe('for whoever checked it out last', () => {
		beforeEach(async () => {
			await striped();
			await insertTurf(FRESH, { lat: north(1) });
		});

		it('lets them back in to finish it', async () => {
			await claim(STRIPED, { slackUserId: ME, releasedAt: '2026-10-16T15:00:00.000Z' });
			expect(await gated()).toEqual(new Set());
		});

		it('still holds it back from everyone else', async () => {
			await claim(STRIPED, { slackUserId: ME, releasedAt: '2026-10-16T15:00:00.000Z' });
			expect(await gated([STRIPED], 'U_SOMEONE')).toEqual(new Set([STRIPED]));
		});

		it('holds it back once someone else has checked it out since', async () => {
			await claim(STRIPED, {
				slackUserId: ME,
				claimedAt: '2026-10-15T12:00:00.000Z',
				releasedAt: '2026-10-15T15:00:00.000Z',
			});
			await claim(STRIPED, {
				slackUserId: 'U_SOMEONE',
				claimedAt: '2026-10-16T12:00:00.000Z',
				releasedAt: '2026-10-16T15:00:00.000Z',
			});
			expect(await gated()).toEqual(new Set([STRIPED]));
		});

		it('lets them re-claim it through claimTurf', async () => {
			await claim(STRIPED, { slackUserId: ME, releasedAt: '2026-10-16T15:00:00.000Z' });
			const result = await claimTurf(db, {
				turfId: STRIPED,
				slackUserId: ME,
				slackUserName: 'Sam',
				now: NOW,
			});
			expect(result).toMatchObject({ ok: true });
		});
	});

	it('judges each striped turf by its own neighbours', async () => {
		await striped();
		await insertTurf(3, { knockedBeforeCut: 30, lat: north(6) });
		await insertTurf(FRESH, { lat: north(1) });
		expect(await gated([STRIPED, 3])).toEqual(new Set([STRIPED]));
	});
});

describe('claimTurf — fresh turf nearby', () => {
	it('refuses striped turf while fresh turf nearby is free, then takes it once that is gone', async () => {
		await striped();
		await insertTurf(FRESH, { lat: north(1) });

		const refused = await claimTurf(db, {
			turfId: STRIPED,
			slackUserId: ME,
			slackUserName: 'Sam',
			now: NOW,
		});
		expect(refused).toMatchObject({ ok: false, status: 409 });
		if (!refused.ok) expect(refused.message).toContain('fresh turf within 2 miles');

		await claim(FRESH);
		const taken = await claimTurf(db, {
			turfId: STRIPED,
			slackUserId: ME,
			slackUserName: 'Sam',
			now: NOW,
		});
		expect(taken).toMatchObject({ ok: true });
	});

	it('takes the fresh turf itself as usual', async () => {
		await striped();
		await insertTurf(FRESH, { lat: north(1) });
		const result = await claimTurf(db, {
			turfId: FRESH,
			slackUserId: ME,
			slackUserName: 'Sam',
			now: NOW,
		});
		expect(result).toMatchObject({ ok: true });
	});
});

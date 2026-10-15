import { describe, afterEach, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { VanClient } from './client.js';
import { KNOCK_LEAD_MS, replaceRoster, upsertContacts } from './contact-sync.js';
import {
	campaignsWithLiveClaims,
	clearContactKindsCache,
	LIVE_MAX_LOOKBACK_MS,
	LIVE_OVERLAP_MS,
	pollLiveContacts,
	turfSyncCheck,
} from './live-contacts.js';
import { createPersonHasher } from './person-hash.js';

// A real in-memory libsql, as in contact-sync.test.ts: the check is one SQL
// count joining blob-keyed tables, and a stub would let it say anything.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const hasher = createPersonHasher('test-secret');
const NOW = new Date('2026-10-13T18:00:00.000Z');
const CLAIMED = '2026-10-13T16:00:00.000Z';
const EXPIRES = '2026-10-15T16:00:00.000Z';
const noSleep = async () => {};

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	clearContactKindsCache();
});

afterEach(() => {
	client.close();
});

async function turf(turfId: number, campaignId = 1) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id, name,
		         saved_list_id, door_count, first_seen_at, last_seen_at, cut_at)
		      VALUES (?1, ?2, ?1, 1, 1, 1, 'Turf', 900, 3, ?3, ?3, ?3)`,
		args: [turfId, campaignId, '2026-10-01T00:00:00.000Z'],
	});
}

async function claim(
	turfId: number,
	over: { user?: string; completedAt?: string; releasedAt?: string; expiresAt?: string } = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at, released_at, completed_at)
		      VALUES (?, ?, 'Dana', ?, ?, ?, ?)`,
		args: [
			turfId,
			over.user ?? 'U1',
			CLAIMED,
			over.expiresAt ?? EXPIRES,
			over.releasedAt ?? null,
			over.completedAt ?? null,
		],
	});
}

/** Person id → address, as a roster. Two people at 1 Main St are one door. */
function roster(people: Record<string, string>) {
	return Object.entries(people).map(([id, address]) => ({
		personHash: hasher.person(id),
		doorHash: hasher.door(address, '48201'),
	}));
}

async function contact(vanId: string, at: string, campaignId = 1) {
	await upsertContacts(
		db,
		campaignId,
		new Map([[vanId, { personHash: hasher.person(vanId), at }]]),
	);
}

async function setState(values: { cursor?: string; liveThrough?: string }) {
	await client.execute({
		sql: 'INSERT INTO van_contact_sync_state (campaign_id, cursor, live_through) VALUES (1, ?, ?)',
		args: [values.cursor ?? null, values.liveThrough ?? null],
	});
}

const HEADER =
	'ContactsContactID,VanID,ResultID,CanvassedBy,CommitteeID,CreatedBy,DateCreated,' +
	'DateCanvassed,InputTypeID,ContactTypeID,ChangeTypeId,ErrorMessage';

function contactRow(vanId: string, contactTypeId: number, canvassed: string): string {
	return `1,${vanId},14,5,122299,5,${canvassed},${canvassed},14,${contactTypeId},1,`;
}

/** A VAN whose every job is `status` and whose file holds `rows`. */
function fakeVan(rows: string[], status = 'Complete') {
	const created: Array<{ dateChangedFrom: string; dateChangedTo: string }> = [];
	let typeReads = 0;
	const van = {
		contactTypes: async () => {
			typeReads++;
			return [
				{ contactTypeId: 2, name: 'Walk', channelTypeName: 'In Person' },
				{ contactTypeId: 1, name: 'Phone', channelTypeName: 'Phone' },
			];
		},
		changeTypes: async () => [{ changeTypeId: 2, changeTypeName: 'Deleted' }],
		createChangedEntityExportJob: async (input: {
			dateChangedFrom: string;
			dateChangedTo: string;
		}) => {
			created.push(input);
			return { exportJobId: created.length };
		},
		changedEntityExportJob: async (id: number) => ({
			exportJobId: id,
			jobStatus: status,
			files: status === 'Complete' ? [{ downloadUrl: `https://blob.example/${id}.csv` }] : null,
		}),
	} as unknown as VanClient;
	const fetchFn = (async () => new Response([HEADER, ...rows].join('\r\n'))) as typeof fetch;
	return { van, fetchFn, created, typeReads: () => typeReads };
}

async function liveThrough() {
	const res = await client.execute('SELECT live_through FROM van_contact_sync_state');
	return res.rows[0]?.live_through ?? null;
}

describe('campaignsWithLiveClaims', () => {
	it('is the enabled campaigns with a claim that is neither ended nor lapsed', async () => {
		await turf(1);
		await claim(1);
		expect(await campaignsWithLiveClaims(db, NOW)).toEqual([{ id: 1, credentialKey: 'primary' }]);
	});

	it('is empty when every claim is done, given back or lapsed: nothing to poll overnight', async () => {
		await turf(1);
		await claim(1, { completedAt: CLAIMED });
		await claim(1, { releasedAt: CLAIMED });
		await claim(1, { expiresAt: '2026-10-13T17:00:00.000Z' });
		expect(await campaignsWithLiveClaims(db, NOW)).toEqual([]);
	});

	it('leaves out a disabled campaign', async () => {
		await turf(1);
		await claim(1);
		await client.execute('UPDATE van_campaigns SET enabled = 0 WHERE id = 1');
		expect(await campaignsWithLiveClaims(db, NOW)).toEqual([]);
	});
});

describe('pollLiveContacts', () => {
	it('reads from just behind the later of its own and the scheduled pull’s reads', async () => {
		await setState({ cursor: '2026-10-13T17:40:00.000Z', liveThrough: '2026-10-13T17:59:30.000Z' });
		const { van, fetchFn, created } = fakeVan([]);

		await pollLiveContacts(db, van, { campaignId: 1, hasher, now: NOW, fetchFn, sleep: noSleep });

		expect(created).toEqual([
			{
				resourceType: 'ContactHistory',
				dateChangedFrom: new Date(
					Date.parse('2026-10-13T17:59:30.000Z') - LIVE_OVERLAP_MS,
				).toISOString(),
				dateChangedTo: NOW.toISOString(),
			},
		]);
		expect(await liveThrough()).toBe(NOW.toISOString());
	});

	// Anything older is the scheduled pull's; a poll that was idle all night
	// must not ask VAN for the whole night.
	it('never reaches back further than the lookback', async () => {
		await setState({ cursor: '2026-10-13T06:00:00.000Z' });
		const { van, fetchFn, created } = fakeVan([]);

		await pollLiveContacts(db, van, { campaignId: 1, hasher, now: NOW, fetchFn, sleep: noSleep });

		expect(created[0]!.dateChangedFrom).toBe(
			new Date(NOW.getTime() - LIVE_MAX_LOOKBACK_MS).toISOString(),
		);
	});

	it('creates the state row on a campaign the scheduled pull has not reached yet', async () => {
		const { van, fetchFn } = fakeVan([]);
		await pollLiveContacts(db, van, { campaignId: 1, hasher, now: NOW, fetchFn, sleep: noSleep });
		expect(await liveThrough()).toBe(NOW.toISOString());
	});

	it('stores in-person contacts only, and leaves the scheduled pull’s cursor alone', async () => {
		await setState({ cursor: '2026-10-13T17:30:00.000Z' });
		const { van, fetchFn } = fakeVan([
			contactRow('111', 2, '10/13/2026 1:55:00 PM'),
			contactRow('222', 1, '10/13/2026 1:56:00 PM'),
		]);

		const result = await pollLiveContacts(db, van, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
		});

		expect(result).toMatchObject({ kind: 'read', contacts: 1, written: 1 });
		const stored = await client.execute('SELECT last_in_person_at FROM van_person_contacts');
		// Detroit is UTC-4 in October.
		expect(stored.rows.map((r) => r.last_in_person_at)).toEqual(['2026-10-13T17:55:00.000Z']);
		const state = await client.execute('SELECT cursor FROM van_contact_sync_state');
		expect(state.rows[0]!.cursor).toBe('2026-10-13T17:30:00.000Z');
	});

	// Each window re-reads the last few minutes: the same contacts come back
	// for several rounds, and only the first writes (or logs) anything.
	it('says nothing was written when a round re-reads contacts already stored', async () => {
		const rows = [contactRow('111', 2, '10/13/2026 1:55:00 PM')];
		const poll = () => {
			const { van, fetchFn } = fakeVan(rows);
			return pollLiveContacts(db, van, {
				campaignId: 1,
				hasher,
				now: NOW,
				fetchFn,
				sleep: noSleep,
			});
		};
		expect(await poll()).toMatchObject({ contacts: 1, written: 1 });
		expect(await poll()).toMatchObject({ contacts: 1, written: 0 });
	});

	it('leaves a job VAN has not finished and does not move liveThrough', async () => {
		const { van, fetchFn } = fakeVan([], 'Pending');
		const result = await pollLiveContacts(db, van, {
			campaignId: 1,
			hasher,
			now: NOW,
			fetchFn,
			sleep: noSleep,
			budgetMs: 0,
		});
		expect(result).toEqual({ kind: 'pending' });
		expect(await liveThrough()).toBeNull();
	});

	it('throws when VAN fails the job', async () => {
		const { van, fetchFn } = fakeVan([], 'Error');
		await expect(
			pollLiveContacts(db, van, { campaignId: 1, hasher, now: NOW, fetchFn, sleep: noSleep }),
		).rejects.toThrow(/failed/);
	});

	it('asks VAN for contact types once, not every half minute', async () => {
		const vanState = fakeVan([]);
		for (let i = 0; i < 3; i++) {
			await pollLiveContacts(db, vanState.van, {
				campaignId: 1,
				hasher,
				now: new Date(NOW.getTime() + i * 30_000),
				fetchFn: vanState.fetchFn,
				sleep: noSleep,
			});
		}
		expect(vanState.typeReads()).toBe(1);
	});
});

describe('upsertContacts', () => {
	// The live poll re-reads its overlap every round; only a later date may
	// change a row.
	it('keeps the later date whichever order they arrive in', async () => {
		await contact('111', '2026-10-13T17:00:00.000Z');
		await contact('111', '2026-10-13T16:00:00.000Z');
		await contact('111', '2026-10-13T17:00:00.000Z');
		let rows = await client.execute('SELECT last_in_person_at FROM van_person_contacts');
		expect(rows.rows.map((r) => r.last_in_person_at)).toEqual(['2026-10-13T17:00:00.000Z']);
		await contact('111', '2026-10-13T17:30:00.000Z');
		rows = await client.execute('SELECT last_in_person_at FROM van_person_contacts');
		expect(rows.rows.map((r) => r.last_in_person_at)).toEqual(['2026-10-13T17:30:00.000Z']);
	});
});

describe('turfSyncCheck', () => {
	beforeEach(async () => {
		await turf(1);
		await replaceRoster(
			db,
			1,
			900,
			roster({ '111': '1 Main St', '112': '1 Main St', '222': '2 Main St', '333': '3 Main St' }),
		);
		await claim(1);
	});

	const check = (slackUserId = 'U1', turfId = 1) =>
		turfSyncCheck(db, { turfId, slackUserId, now: NOW });

	it('counts doors with an in-person contact since the claim', async () => {
		// Both residents of 1 Main St: one door.
		await contact('111', '2026-10-13T16:30:00.000Z');
		await contact('112', '2026-10-13T16:31:00.000Z');
		await contact('222', '2026-10-13T17:00:00.000Z');
		// Knocked last week, by someone else: not this walk.
		await contact('333', '2026-10-06T17:00:00.000Z');

		expect(await check()).toMatchObject({ doors: 2, totalDoors: 3 });
	});

	it('counts a knock from just before the claim landed, as doors knocked does', async () => {
		await contact('333', new Date(Date.parse(CLAIMED) - KNOCK_LEAD_MS).toISOString());
		expect(await check()).toMatchObject({ doors: 1 });
	});

	it('is 0, not null, before the sync lands', async () => {
		expect(await check()).toMatchObject({ doors: 0, totalDoors: 3 });
	});

	it('ignores another campaign’s contacts', async () => {
		await contact('111', '2026-10-13T16:30:00.000Z', 2);
		expect(await check()).toMatchObject({ doors: 0 });
	});

	it('says when VAN was last read, by either pull', async () => {
		await setState({ cursor: '2026-10-13T17:30:00.000Z', liveThrough: '2026-10-13T17:59:30.000Z' });
		expect(await check()).toMatchObject({
			checkedThrough: '2026-10-13T17:59:30.000Z',
			checkedAgeMs: Date.parse(NOW.toISOString()) - Date.parse('2026-10-13T17:59:30.000Z'),
		});
	});

	it('is null doors on a turf with no roster to count against', async () => {
		await turf(2);
		await claim(2);
		expect(await check('U1', 2)).toEqual({
			doors: null,
			totalDoors: null,
			checkedThrough: null,
			checkedAgeMs: null,
		});
	});

	// Nothing about turf the caller does not hold.
	it('is null for someone else, or once the claim has ended', async () => {
		expect(await check('U2')).toBeNull();
		await client.execute(`UPDATE van_turf_checkouts SET completed_at = '${NOW.toISOString()}'`);
		expect(await check()).toBeNull();
	});
});

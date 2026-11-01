import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
	releaseAllVanAssignments,
	countByFolder,
	releaseVanAssignment,
	vanOnlyHeldTurfs,
	type VanHeldTurf,
} from './turf-van-release-store.js';
import { loadChapterTurfs } from './turf-query.js';

// A real in-memory libsql, because what a release does is read back through
// loadChapterTurfs, the same path the card is built from.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-10-10T18:00:00.000Z');
const MODERATOR = { id: 'U_MOD', name: 'Mo' };
/** When the fixtures' turf were handed out in VAN. */
const HANDED_OUT = '2026-10-01T12:00:00.000Z';
/** When the card the release is clicked on was built. */
const CARD_BUILT = '2026-10-10T17:30:00.000Z';
const seen = (since: string | null) => ({ since, seenAt: new Date(CARD_BUILT) });

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });

	await client.execute({
		sql: `INSERT INTO van_chapter_folders
		        (campaign_id, chapter_id, folder_id, chapter_name, last_edited_by,
		         last_edited_by_name, last_edited_at)
		      VALUES (1, 71, 1, 'Washtenaw County', 'U_ADMIN', 'Alex', ?)`,
		args: [NOW.toISOString()],
	});
	// 100 is handed out in VAN, with no count, so the time limit cannot free it.
	// 101 is not handed out.
	for (const [id, holder] of [
		[100, 'Sam Ito'],
		[101, null],
	] as const) {
		await client.execute({
			sql: `INSERT INTO van_turfs
			        (turf_id, van_map_route_id, map_region_id, folder_id, chapter_id, chapter_name,
			         region_name, name, printed_list_number, door_count, first_seen_at, last_seen_at,
			         van_distributed_to, van_assigned_at)
			      VALUES (?, ?, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', ?, ?, 250, ?, ?, ?, ?)`,
			args: [
				id,
				id,
				`Turf ${id}`,
				`L-${id}`,
				NOW.toISOString(),
				NOW.toISOString(),
				holder,
				holder ? '2026-10-01T12:00:00.000Z' : null,
			],
		});
	}
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

const card = async (turfId: number) =>
	(
		await loadChapterTurfs(db, {
			chapterId: 71,
			viewer: { slackUserId: 'U_MOD', isAdmin: false, isModerator: true },
			now: NOW,
		})
	).turfs.find((t) => t.turfId === turfId)!;

describe('releaseVanAssignment', () => {
	it('puts turf held in VAN back in the pool, and stamps who released it', async () => {
		expect(await card(100)).toMatchObject({
			status: 'checked-out',
			heldInVan: { since: HANDED_OUT, seenAt: NOW.toISOString() },
		});

		expect(await releaseVanAssignment(db, 100, seen(HANDED_OUT), MODERATOR, NOW, 48)).toBe(
			'released',
		);

		const view = await card(100);
		expect(view.status).toBe('available');
		expect(view.heldInVan).toBeUndefined();
		const { rows } = await client.execute(
			`SELECT van_distributed_to, van_assigned_at, van_released_at, van_released_by
			   FROM van_turfs WHERE turf_id = 100`,
		);
		expect(rows[0]).toMatchObject({
			van_distributed_to: null,
			van_assigned_at: null,
			// The hand-out's own time, not the click's.
			van_released_at: '2026-10-01T12:00:00.000Z',
			van_released_by: 'Mo',
		});
	});

	// The card loaded, then someone loaded the list and the sync read it: the
	// newer hand-out is theirs, and the click on the stale card must not end it.
	it('refuses a hand-out VAN made after the card loaded', async () => {
		await client.execute(
			"UPDATE van_turfs SET van_distributed_to = 'Dana Ruiz', van_assigned_at = '2026-10-10T17:00:00.000Z' WHERE turf_id = 100",
		);
		expect(await releaseVanAssignment(db, 100, seen(HANDED_OUT), MODERATOR, NOW, 48)).toBe(
			'changed',
		);
		const { rows } = await client.execute(
			'SELECT van_distributed_to, van_released_at FROM van_turfs WHERE turf_id = 100',
		);
		expect(rows[0]).toMatchObject({ van_distributed_to: 'Dana Ruiz', van_released_at: null });
	});

	it('releases a hand-out with no date when the card saw none', async () => {
		await client.execute('UPDATE van_turfs SET van_assigned_at = NULL WHERE turf_id = 100');
		expect(await releaseVanAssignment(db, 100, seen(HANDED_OUT), MODERATOR, NOW, 48)).toBe(
			'changed',
		);
		expect(await releaseVanAssignment(db, 100, seen(null), MODERATOR, NOW, 48)).toBe('released');
	});

	// With no date to cut off at, the release ends at the card's build time:
	// a MiniVAN load between that and the click is someone else's, and must
	// still hold the turf once the sync reads it.
	it('releases a hand-out with no date as of when the card was built', async () => {
		await client.execute('UPDATE van_turfs SET van_assigned_at = NULL WHERE turf_id = 100');
		await releaseVanAssignment(db, 100, seen(null), MODERATOR, NOW, 48);
		const { rows } = await client.execute(
			'SELECT van_released_at FROM van_turfs WHERE turf_id = 100',
		);
		expect(rows[0]!.van_released_at).toBe(CARD_BUILT);
	});

	it('never releases as of a time after the click', async () => {
		await client.execute('UPDATE van_turfs SET van_assigned_at = NULL WHERE turf_id = 100');
		const future = { since: null, seenAt: new Date('2027-01-01T00:00:00.000Z') };
		await releaseVanAssignment(db, 100, future, MODERATOR, NOW, 48);
		const { rows } = await client.execute(
			'SELECT van_released_at FROM van_turfs WHERE turf_id = 100',
		);
		expect(rows[0]!.van_released_at).toBe(NOW.toISOString());
	});

	it('refuses turf VAN has not handed out, and turf that does not exist', async () => {
		expect(await releaseVanAssignment(db, 101, seen(null), MODERATOR, NOW, 48)).toBe('not-held');
		expect(await releaseVanAssignment(db, 999, seen(null), MODERATOR, NOW, 48)).toBe('not-found');
		const { rows } = await client.execute(
			'SELECT van_released_at FROM van_turfs WHERE turf_id = 101',
		);
		expect(rows[0]!.van_released_at).toBeNull();
	});
});

describe('releaseVanAssignment — what it leaves held', () => {
	it('refuses turf a claim here holds, or the Packet Tracker lists', async () => {
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts
			        (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at)
			      VALUES (100, 'U_VOL', 'Dana', ?, ?)`,
			args: ['2026-10-10T12:00:00.000Z', '2026-10-12T12:00:00.000Z'],
		});
		expect(await releaseVanAssignment(db, 100, seen(HANDED_OUT), MODERATOR, NOW, 48)).toBe(
			'claimed',
		);
		await client.execute('DELETE FROM van_turf_checkouts');
		await client.execute("UPDATE van_turfs SET sheet_assigned_to = 'Ana Ruiz' WHERE turf_id = 100");
		expect(await releaseVanAssignment(db, 100, seen(HANDED_OUT), MODERATOR, NOW, 48)).toBe('sheet');
	});

	// The card and the release read one rule (heldOnlyInVan), so the button
	// is never shown on turf the release would refuse.
	it('refuses retired turf, which the card offers no button on', async () => {
		await client.execute({
			sql: 'UPDATE van_turfs SET retired_at = ? WHERE turf_id = 100',
			args: [NOW.toISOString()],
		});
		expect(await releaseVanAssignment(db, 100, seen(HANDED_OUT), MODERATOR, NOW, 48)).toBe(
			'not-held',
		);
	});

	it('reads a blank Packet Tracker entry as none, as the card does', async () => {
		await client.execute("UPDATE van_turfs SET sheet_assigned_to = '' WHERE turf_id = 100");
		expect(await card(100)).toMatchObject({ heldInVan: expect.anything() });
		expect(await releaseVanAssignment(db, 100, seen(HANDED_OUT), MODERATOR, NOW, 48)).toBe(
			'released',
		);
	});

	it('releases turf whose claim here has lapsed unswept', async () => {
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts
			        (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at)
			      VALUES (100, 'U_VOL', 'Dana', ?, ?)`,
			args: ['2026-10-08T12:00:00.000Z', '2026-10-10T12:00:00.000Z'],
		});
		expect(await releaseVanAssignment(db, 100, seen(HANDED_OUT), MODERATOR, NOW, 48)).toBe(
			'released',
		);
	});

	it('refuses a hand-out the time limit has already let go', async () => {
		await client.execute(
			'UPDATE van_turfs SET saved_list_id = 7, roster_saved_list_id = 7, uncontacted_doors = 40 WHERE turf_id = 100',
		);
		expect(await releaseVanAssignment(db, 100, seen(HANDED_OUT), MODERATOR, NOW, 48)).toBe(
			'not-held',
		);
	});

	// Someone loading the list between the release and the next sync reading
	// their export: the sync must still be able to hold the turf for them.
	it('leaves a later MiniVAN load able to hold the turf again', async () => {
		await releaseVanAssignment(db, 100, seen(HANDED_OUT), MODERATOR, NOW, 48);
		await client.execute(
			"UPDATE van_turfs SET van_distributed_to = 'Dana Ruiz', van_assigned_at = '2026-10-10T17:55:00.000Z' WHERE turf_id = 100",
		);
		expect(await card(100)).toMatchObject({ status: 'checked-out', heldInVan: expect.anything() });
	});
});

describe('releaseAllVanAssignments', () => {
	/** Another turf handed out in VAN, with `over` as extra columns. */
	const handedOut = async (turfId: number, over: Record<string, string | number> = {}) => {
		const cols = Object.keys(over);
		await client.execute({
			sql: `INSERT INTO van_turfs
			        (turf_id, van_map_route_id, map_region_id, folder_id, chapter_id, chapter_name,
			         region_name, name, printed_list_number, door_count, first_seen_at, last_seen_at,
			         van_distributed_to, van_assigned_at${cols.map((c) => `, ${c}`).join('')})
			      VALUES (?, ?, 1, 1, 71, 'Washtenaw County', 'Ann Arbor', ?, ?, 250, ?, ?,
			              'Sam Ito', '2026-10-01T12:00:00.000Z'${cols.map(() => ', ?').join('')})`,
			args: [
				turfId,
				turfId,
				`Turf ${turfId}`,
				`L-${turfId}`,
				NOW.toISOString(),
				NOW.toISOString(),
				...Object.values(over),
			],
		});
	};

	beforeEach(async () => {
		// Claimed here, live.
		await handedOut(102);
		await client.execute({
			sql: `INSERT INTO van_turf_checkouts
			        (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at)
			      VALUES (102, 'U_VOL', 'Dana', ?, ?)`,
			args: ['2026-10-10T12:00:00.000Z', '2026-10-12T12:00:00.000Z'],
		});
		// In the campaign's Packet Tracker.
		await handedOut(103, { sheet_assigned_to: 'Ana Ruiz' });
		// In the campaign's requested-turf folder.
		await handedOut(104);
		await client.execute('UPDATE van_turfs SET folder_id = 9 WHERE turf_id = 104');
		await client.execute(
			`INSERT INTO van_campaigns
			   (id, credential_key, requested_folder_id, last_edited_by, last_edited_by_name, last_edited_at)
			 VALUES (1, 'primary', 9, 's', 's', 'x')
			 ON CONFLICT (id) DO UPDATE SET requested_folder_id = 9`,
		);
		// Past the time limit with a current count, so already back in the pool.
		await handedOut(105, { saved_list_id: 7, roster_saved_list_id: 7, uncontacted_doors: 40 });
	});

	it('frees only turf held by a VAN hand-out alone', async () => {
		const held = await vanOnlyHeldTurfs(db, NOW, 48);
		expect(held).toEqual([
			{
				turfId: 100,
				campaignId: 1,
				folderId: 1,
				chapterName: 'Washtenaw County',
				since: HANDED_OUT,
			},
		]);
		// Every turf offered, as a forged request could: only 100 goes.
		const everything = [100, 101, 102, 103, 104, 105].map((turfId) => ({
			turfId,
			since: HANDED_OUT,
		}));
		expect(await releaseAllVanAssignments(db, everything, NOW, MODERATOR, NOW, 48)).toBe(1);

		const { rows } = await client.execute(
			'SELECT turf_id, van_distributed_to, van_released_by FROM van_turfs ORDER BY turf_id',
		);
		expect(rows.map((r) => [r.turf_id, r.van_distributed_to, r.van_released_by])).toEqual([
			[100, null, 'Mo'],
			[101, null, null],
			[102, 'Sam Ito', null],
			[103, 'Sam Ito', null],
			[104, 'Sam Ito', null],
			[105, 'Sam Ito', null],
		]);
	});

	it('counts turf whose claim here has ended', async () => {
		await client.execute({
			sql: 'UPDATE van_turf_checkouts SET released_at = ? WHERE turf_id = 102',
			args: [NOW.toISOString()],
		});
		expect((await vanOnlyHeldTurfs(db, NOW, 48)).map((t) => t.turfId)).toEqual([100, 102]);
	});

	it('releases only the turf the summary counted, under the hand-out it saw', async () => {
		await client.execute({
			sql: 'UPDATE van_turf_checkouts SET released_at = ? WHERE turf_id = 102',
			args: [NOW.toISOString()],
		});
		const counted = (await vanOnlyHeldTurfs(db, NOW, 48)).map((t) => ({
			turfId: t.turfId,
			since: t.since,
		}));
		// After the count: 100 is loaded in MiniVAN again, and 106 is handed out.
		await client.execute(
			"UPDATE van_turfs SET van_assigned_at = '2026-10-10T17:00:00.000Z' WHERE turf_id = 100",
		);
		await handedOut(106);
		expect(await releaseAllVanAssignments(db, counted, NOW, MODERATOR, NOW, 48)).toBe(1);
		const { rows } = await client.execute(
			'SELECT turf_id FROM van_turfs WHERE van_distributed_to IS NOT NULL ORDER BY turf_id',
		);
		expect(rows.map((r) => r.turf_id)).toEqual([100, 103, 104, 105, 106]);
	});
});

describe('countByFolder', () => {
	const turf = (turfId: number, campaignId: number, folderId: number): VanHeldTurf => ({
		turfId,
		campaignId,
		folderId,
		chapterName: `Chapter ${folderId}`,
		since: null,
	});

	it('counts by VAN folder, largest first, named from VAN when it can be', () => {
		const names = new Map([[1, new Map([[10, 'R06F_Washtenaw ']])]]);
		expect(
			countByFolder([turf(1, 1, 20), turf(2, 1, 10), turf(3, 1, 10)], names, new Map()),
		).toEqual([
			{
				campaignId: 1,
				campaign: null,
				folderId: 10,
				name: 'R06F_Washtenaw',
				chapterName: 'Chapter 10',
				count: 2,
			},
			{
				campaignId: 1,
				campaign: null,
				folderId: 20,
				name: null,
				chapterName: 'Chapter 20',
				count: 1,
			},
		]);
	});

	// Folder ids are VAN's, unique only within one committee.
	it('keeps two campaigns’ folders with the same id apart, and names the campaign', () => {
		const campaigns = new Map([
			[1, 'Primary'],
			[2, 'Coordinated'],
		]);
		const folders = countByFolder([turf(1, 1, 10), turf(2, 2, 10)], new Map(), campaigns);
		expect(folders.map((f) => [f.campaign, f.folderId, f.count])).toEqual([
			['Coordinated', 10, 1],
			['Primary', 10, 1],
		]);
	});

	it('keeps apart two campaigns that share a name', () => {
		const campaigns = new Map([
			[1, 'Spring'],
			[2, 'Spring'],
		]);
		const folders = countByFolder([turf(1, 1, 12), turf(2, 2, 12)], new Map(), campaigns);
		expect(folders.map((f) => [f.campaignId, f.folderId])).toEqual([
			[1, 12],
			[2, 12],
		]);
	});
});

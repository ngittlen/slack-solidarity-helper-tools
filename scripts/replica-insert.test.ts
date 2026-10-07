import { describe, it, expect, beforeEach } from 'vitest';
import { createClient, type Client, type ResultSet } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { insertRows } from './replica-insert.js';
import { OutsideIdScrubber } from './replica-scrub.js';

// The real tables, from the real migrations: the point is what the primary
// keys do once names have been swapped for stand-ins.

let local: Client;

beforeEach(async () => {
	local = createClient({ url: ':memory:' });
	await migrate(drizzle(local), { migrationsFolder: 'drizzle' });
});

const rows = (...items: Record<string, unknown>[]) => items as unknown as ResultSet['rows'];

const KNOCK = ['date', 'code', 'canvasser', 'chapter_name', 'attempts', 'contacts'];

function learnedJane() {
	const scrubber = new OutsideIdScrubber();
	// Two spellings of one volunteer: a refreshed profile, an older claim.
	scrubber.learn('google:1', 'Jane Doe');
	scrubber.learn('google:1', 'Jane D');
	return scrubber;
}

describe('insertRows', () => {
	it('skips and counts a door-knock row that collides once names are stand-ins', async () => {
		const skipped = await insertRows(
			local,
			'door_knock_canvasser_daily',
			KNOCK,
			rows(
				{
					date: '2026-10-01',
					code: 'A',
					canvasser: 'Jane Doe',
					chapter_name: '',
					attempts: 9,
					contacts: 3,
				},
				{
					date: '2026-10-01',
					code: 'A',
					canvasser: 'Jane D',
					chapter_name: '',
					attempts: 4,
					contacts: 1,
				},
				{
					date: '2026-10-01',
					code: 'A',
					canvasser: 'Dana',
					chapter_name: '',
					attempts: 2,
					contacts: 0,
				},
			),
			learnedJane(),
		);

		expect(skipped).toBe(1);
		const copied = await local.execute(
			'SELECT canvasser, attempts FROM door_knock_canvasser_daily ORDER BY canvasser',
		);
		expect(copied.rows.map((r) => ({ ...r }))).toEqual([
			{ canvasser: 'Dana', attempts: 2 },
			{ canvasser: 'Google volunteer 1', attempts: 9 },
		]);
	});

	it('counts nothing when nothing collides', async () => {
		expect(
			await insertRows(
				local,
				'door_knock_canvasser_daily',
				KNOCK,
				rows({
					date: '2026-10-01',
					code: 'A',
					canvasser: 'Dana',
					chapter_name: '',
					attempts: 1,
					contacts: 0,
				}),
				new OutsideIdScrubber(),
			),
		).toBe(0);
	});

	// Only the name-keyed tables are forgiving: anywhere else a duplicate is a
	// real problem with the copy, and must stop it.
	it('still fails on a duplicate in any other table', async () => {
		const block = {
			slack_user_id: 'U1',
			display_name: 'Dana',
			reason: null,
			last_edited_by: 'U_ADMIN',
			last_edited_by_name: 'Admin',
			last_edited_at: '2026-10-01',
		};
		await expect(
			insertRows(
				local,
				'van_blocked_users',
				Object.keys(block),
				rows(block, block),
				new OutsideIdScrubber(),
			),
		).rejects.toThrow();
	});

	it('writes nothing for an empty page', async () => {
		expect(
			await insertRows(local, 'door_knock_canvasser_daily', KNOCK, rows(), new OutsideIdScrubber()),
		).toBe(0);
	});
});

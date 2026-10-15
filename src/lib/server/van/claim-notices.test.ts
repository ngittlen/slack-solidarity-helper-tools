import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock('./holder-notices.js', () => ({ notifyHolder: mockNotify }));

import { LAPSE_NOTICE_WINDOW_MS, notifyDoorsCounted, notifyLapsedClaims } from './claim-notices.js';

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-10-13T18:00:00.000Z');
const APP = 'https://app.example';
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

beforeEach(async () => {
	vi.clearAllMocks();
	mockNotify.mockResolvedValue(true);
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await client.execute(
		`INSERT INTO van_turfs
		   (turf_id, van_map_route_id, map_region_id, folder_id, chapter_id, name, saved_list_id,
		    door_count, first_seen_at, last_seen_at)
		 VALUES (1, 1, 1, 1, 4, 'Kent 03 Turf 05', 900, 40, '2026-10-01T00:00:00.000Z',
		         '2026-10-13T00:00:00.000Z')`,
	);
});

afterEach(() => {
	client.close();
});

async function checkout(over: Record<string, string | number | null>) {
	const row = {
		turf_id: 1,
		slack_user_id: 'U1',
		slack_user_name: 'Dana',
		claimed_at: minutesAgo(600),
		expires_at: minutesAgo(30),
		...over,
	};
	const cols = Object.keys(row);
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
		args: Object.values(row),
	});
}

async function stamps() {
	const res = await client.execute(
		'SELECT lapse_notified_at, doors_counted_notified_at FROM van_turf_checkouts',
	);
	return res.rows.map((r) => ({ ...r }));
}

describe('notifyLapsedClaims', () => {
	it('tells the holder once, with a link back to their chapter', async () => {
		await checkout({ released_at: minutesAgo(5), release_reason: 'expired' });

		expect(await notifyLapsedClaims(db, { now: NOW, appUrl: APP })).toEqual({ sent: 1, failed: 0 });
		expect(mockNotify).toHaveBeenCalledWith(
			db,
			'U1',
			'lapsed',
			expect.stringContaining('Kent 03 Turf 05'),
			'[van]',
			NOW,
		);
		expect(mockNotify.mock.calls[0]![3]).toContain(`${APP}/turfs?chapter=4`);
		expect((await stamps())[0]!.lapse_notified_at).toBe(NOW.toISOString());

		await notifyLapsedClaims(db, { now: NOW, appUrl: APP });
		expect(mockNotify).toHaveBeenCalledTimes(1);
	});

	it('leaves a failed notice unstamped, for the next sync to retry', async () => {
		mockNotify.mockResolvedValue(false);
		await checkout({ released_at: minutesAgo(5), release_reason: 'expired' });
		expect(await notifyLapsedClaims(db, { now: NOW, appUrl: APP })).toEqual({ sent: 0, failed: 1 });
		expect((await stamps())[0]!.lapse_notified_at).toBeNull();
	});

	it('says nothing about a release the volunteer chose, or a lapse long past', async () => {
		await checkout({ released_at: minutesAgo(5), release_reason: 'volunteer' });
		await checkout({ completed_at: minutesAgo(5) });
		await checkout({
			released_at: new Date(NOW.getTime() - LAPSE_NOTICE_WINDOW_MS - 60_000).toISOString(),
			release_reason: 'expired',
		});
		expect(await notifyLapsedClaims(db, { now: NOW, appUrl: APP })).toEqual({ sent: 0, failed: 0 });
	});
});

describe('notifyDoorsCounted', () => {
	it('tells the holder VAN has their doors, with the count so far, once', async () => {
		await checkout({ completed_at: minutesAgo(90), doors_knocked: 23 });

		expect(await notifyDoorsCounted(db, { now: NOW, appUrl: APP })).toEqual({ sent: 1, failed: 0 });
		expect(mockNotify).toHaveBeenCalledWith(
			db,
			'U1',
			'doors-counted',
			expect.stringContaining('VAN has your doors from Kent 03 Turf 05'),
			'[van]',
			NOW,
		);
		expect(mockNotify.mock.calls[0]![3]).toContain('It had 23 doors when we checked.');
		await notifyDoorsCounted(db, { now: NOW, appUrl: APP });
		expect(mockNotify).toHaveBeenCalledTimes(1);
	});

	// Zero is the door-delta nudge's to say; null is "not counted yet".
	it('waits for a count above zero', async () => {
		await checkout({ completed_at: minutesAgo(90), doors_knocked: 0 });
		await checkout({ completed_at: minutesAgo(90), doors_knocked: null });
		expect(await notifyDoorsCounted(db, { now: NOW, appUrl: APP })).toEqual({ sent: 0, failed: 0 });
	});

	it('leaves completions from more than a day ago alone', async () => {
		await checkout({ completed_at: minutesAgo(25 * 60), doors_knocked: 10 });
		expect(await notifyDoorsCounted(db, { now: NOW, appUrl: APP })).toEqual({ sent: 0, failed: 0 });
	});
});

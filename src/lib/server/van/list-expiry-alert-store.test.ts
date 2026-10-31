import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const mockPostAlert = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/slack.js', () => ({ postAlert: mockPostAlert }));

const { sendListExpiryAlerts } = await import('./list-expiry-alert-store.js');

// Real in-memory libsql, as drift-alert-store.test.ts uses: the guarantee is
// that each list is announced ONCE however many times the sync runs, and that
// lives in a column stamped by one run and read back by the next.

let db: ReturnType<typeof drizzle>;
let client: Client;

const NOW = new Date('2026-09-19T16:00:00.000Z');
const DAY = 24 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const CHANNEL = 'C_TURF';
const APP = 'https://app.example.org';

/** A creation date that makes the list expire `days` from NOW. */
const createdExpiringIn = (days: number) => iso(NOW.getTime() + days * DAY - 30 * DAY);

const run = (over: Partial<Parameters<typeof sendListExpiryAlerts>[1]> = {}) =>
	sendListExpiryAlerts(db, { now: NOW, channelId: CHANNEL, appUrl: APP, ...over });

async function turf(turfId: number, over: Record<string, string | null> = {}): Promise<void> {
	const row: Record<string, string | number | null> = {
		turf_id: turfId,
		van_map_route_id: turfId,
		map_region_id: 1,
		folder_id: 1,
		chapter_id: 71,
		chapter_name: 'Livingston County',
		region_name: 'Brighton',
		name: `Turf ${turfId}`,
		printed_list_number: '35536745-88712',
		printed_list_created_at: createdExpiringIn(3),
		first_seen_at: iso(NOW.getTime()),
		last_seen_at: iso(NOW.getTime()),
		...over,
	};
	const cols = Object.keys(row).join(', ');
	const vals = Object.values(row)
		.map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`))
		.join(', ');
	await client.execute(`INSERT INTO van_turfs (${cols}) VALUES (${vals})`);
}

async function stamps(): Promise<Array<string | null>> {
	const res = await client.execute('SELECT list_expiry_warned_for FROM van_turfs ORDER BY turf_id');
	return res.rows.map((r) => (r.list_expiry_warned_for as string | null) ?? null);
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mockPostAlert.mockResolvedValue(true);
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

// Each test opens its own in-memory client and replaces console. Both leak for
// the life of the worker otherwise — `clearAllMocks` resets a spy's recorded
// calls but leaves it installed. Neither is visible while this file is run on
// its own, which is the shape of a test that fails once in a full suite and
// passes every time you go looking for it.
afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

describe('sendListExpiryAlerts', () => {
	it('announces a list inside the window once, however often the sync runs', async () => {
		await turf(100);
		await turf(101, { printed_list_created_at: createdExpiringIn(12) });

		expect(await run()).toEqual({ announced: 1, failed: false });
		expect(mockPostAlert).toHaveBeenCalledTimes(1);
		expect(mockPostAlert.mock.calls[0]![0]).toBe(CHANNEL);
		expect(await stamps()).toEqual([createdExpiringIn(3), null]);

		expect(await run()).toMatchObject({ announced: 0, skipped: 'nothing-new' });
		expect(mockPostAlert).toHaveBeenCalledTimes(1);
	});

	it('announces again once the list is regenerated and nears its own expiry', async () => {
		await turf(100);
		await run();
		// The catalog writes the new list's creation date; the stamp still holds
		// the old one, so this list has not been announced.
		await client.execute(
			`UPDATE van_turfs SET printed_list_created_at = '${createdExpiringIn(1)}'`,
		);
		expect(await run()).toMatchObject({ announced: 1 });
	});

	it('retries next run when Slack rejects the post', async () => {
		await turf(100);
		mockPostAlert.mockResolvedValueOnce(false);
		expect(await run()).toEqual({ announced: 0, failed: true });
		expect(await stamps()).toEqual([null]);
		expect(await run()).toMatchObject({ announced: 1 });
	});

	it('stamps nothing with no channel, so setting one later still announces', async () => {
		await turf(100);
		expect(await run({ channelId: '' })).toMatchObject({ skipped: 'no-channel' });
		expect(mockPostAlert).not.toHaveBeenCalled();
		expect(await stamps()).toEqual([null]);
	});

	it('skips retired turf', async () => {
		await turf(100, { retired_at: iso(NOW.getTime() - DAY) });
		expect(await run()).toMatchObject({ announced: 0, skipped: 'nothing-new' });
	});

	it('notes turf someone is holding', async () => {
		await turf(100);
		await client.execute(
			`INSERT INTO van_turf_checkouts (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at)
			 VALUES (100, 'U_VOL', 'Dana', '${iso(NOW.getTime() - DAY)}', '${iso(NOW.getTime() + DAY)}')`,
		);
		await run();
		expect(mockPostAlert.mock.calls[0]![1]).toContain('someone holds it');
	});

	// specs/012-multi-van-campaigns: a disabled campaign's turf is no longer
	// handed out and its data is frozen — unless someone is still out with it.
	describe('with a second campaign', () => {
		beforeEach(async () => {
			await client.execute(`UPDATE van_campaigns SET label = 'One Team Michigan' WHERE id = 1`);
			await client.execute(
				`INSERT INTO van_campaigns (id, credential_key, label, enabled, last_edited_by, last_edited_by_name, last_edited_at)
				 VALUES (2, 'partner', 'El-Sayed', 1, 's', 's', 'x')`,
			);
			await turf(100);
			await turf(200, { campaign_id: '2', van_map_route_id: '100' });
		});

		it('names the campaign on each line while both are enabled', async () => {
			await run();
			const text = mockPostAlert.mock.calls[0]![1] as string;
			expect(text).toContain('*Turf 100* — One Team Michigan · Brighton');
			expect(text).toContain('*Turf 200* — El-Sayed · Brighton');
		});

		it('leaves out a disabled campaign’s turf nobody holds', async () => {
			await client.execute('UPDATE van_campaigns SET enabled = 0 WHERE id = 2');
			expect(await run()).toEqual({ announced: 1, failed: false });
			expect(mockPostAlert.mock.calls[0]![1]).not.toContain('Turf 200');
		});

		it('still warns about a disabled campaign’s turf someone is out with', async () => {
			await client.execute('UPDATE van_campaigns SET enabled = 0 WHERE id = 2');
			await client.execute(
				`INSERT INTO van_turf_checkouts (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at)
				 VALUES (200, 'U_VOL', 'Dana', '${iso(NOW.getTime() - DAY)}', '${iso(NOW.getTime() + DAY)}')`,
			);
			await run();
			const text = mockPostAlert.mock.calls[0]![1] as string;
			expect(text).toContain('*Turf 200* — El-Sayed · Brighton');
			expect(text).toContain('someone holds it');
		});
	});
});

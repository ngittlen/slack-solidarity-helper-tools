// The Mobilize sync's ledger against a real (in-memory) libSQL database,
// migrated as production is.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { TursoLedger } from './mobilize-ledger.js';

let client: Client;
let db: ReturnType<typeof drizzle>;
/** Statements the client was asked to run, by method. */
let calls: string[];

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await migrate(drizzle(client), { migrationsFolder: 'drizzle' });
	calls = [];
	const counted = new Proxy(client, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== 'function') return value;
			return (...args: unknown[]) => {
				calls.push(String(prop));
				return value.apply(target, args);
			};
		},
	});
	db = drizzle(counted);
});

afterEach(() => {
	client.close();
});

describe('TursoLedger', () => {
	it('reads the geocoded zips once for the whole run', async () => {
		await client.execute(
			"INSERT INTO mobilize_geocoded_zips VALUES ('42.1,-83.1', '48201', 'now'), ('42.2,-83.2', '48202', 'now')",
		);
		const ledger = new TursoLedger(db);

		expect(await ledger.zipFor('42.1,-83.1')).toBe('48201');
		expect(await ledger.zipFor('42.2,-83.2')).toBe('48202');
		expect(await ledger.zipFor('42.3,-83.3')).toBeNull();
		expect(calls).toHaveLength(1);
	});

	it('reads the zips again after a read that failed, rather than failing every lookup', async () => {
		await client.execute(
			"INSERT INTO mobilize_geocoded_zips VALUES ('42.1,-83.1', '48201', 'now')",
		);
		let blip = true;
		const flaky = new Proxy(db, {
			get(target, prop) {
				if (prop === 'select' && blip) {
					blip = false;
					return () => ({ from: () => Promise.reject(new Error('Turso blip')) });
				}
				return Reflect.get(target, prop, target);
			},
		});
		const ledger = new TursoLedger(flaky);

		await expect(ledger.zipFor('42.1,-83.1')).rejects.toThrow('Turso blip');
		expect(await ledger.zipFor('42.1,-83.1')).toBe('48201');
	});

	it('answers a zip it just recorded, and keeps the first one for a point', async () => {
		const ledger = new TursoLedger(db);
		await ledger.recordZip('42.1,-83.1', '48201');
		await ledger.recordZip('42.1,-83.1', '49999');

		expect(await ledger.zipFor('42.1,-83.1')).toBe('48201');
		const stored = await client.execute('SELECT postal_code FROM mobilize_geocoded_zips');
		expect(stored.rows.map((r) => r.postal_code)).toEqual(['48201']);
	});

	it('reads the copied images once, and answers a re-upload with the new URL', async () => {
		await client.execute(
			"INSERT INTO mobilize_synced_images VALUES ('https://src/a.png', 'https://old/a.png', 'now')",
		);
		const ledger = new TursoLedger(db);

		expect(await ledger.imageFor('https://src/a.png')).toBe('https://old/a.png');
		expect(await ledger.imageFor('https://src/b.png')).toBeNull();
		await ledger.recordImage('https://src/a.png', 'https://new/a.png');

		expect(await ledger.imageFor('https://src/a.png')).toBe('https://new/a.png');
		const stored = await client.execute('SELECT mobilize_url FROM mobilize_synced_images');
		expect(stored.rows.map((r) => r.mobilize_url)).toEqual(['https://new/a.png']);
	});

	it("writes an event's timeslot pairings and pushed caps in one batch each", async () => {
		const ledger = new TursoLedger(db);
		await ledger.recordTimeslots([
			{
				mobilizeTimeslotId: 1,
				mobilizeEventId: 10,
				solidarityEventId: 20,
				solidaritySessionId: 30,
			},
			{
				mobilizeTimeslotId: 2,
				mobilizeEventId: 10,
				solidarityEventId: 20,
				solidaritySessionId: 31,
			},
		]);
		await ledger.recordTimeslots([
			{
				mobilizeTimeslotId: 2,
				mobilizeEventId: 10,
				solidarityEventId: 20,
				solidaritySessionId: 32,
			},
		]);
		await ledger.recordPushedCaps([
			{ mobilizeTimeslotId: 1, maxAttendees: 5 },
			{ mobilizeTimeslotId: 2, maxAttendees: null },
		]);

		expect(calls).toEqual(['batch', 'batch', 'batch']);
		expect(await ledger.pushedCaps()).toEqual(
			new Map([
				[1, 5],
				[2, null],
			]),
		);
		const sessions = await client.execute(
			'SELECT mobilize_timeslot_id, solidarity_session_id FROM mobilize_synced_timeslots ORDER BY 1',
		);
		expect(sessions.rows.map((r) => [r.mobilize_timeslot_id, r.solidarity_session_id])).toEqual([
			[1, 30],
			[2, 32],
		]);
	});

	it('sends nothing for no pairings or caps', async () => {
		const ledger = new TursoLedger(db);
		await ledger.recordTimeslots([]);
		await ledger.recordPushedCaps([]);
		expect(calls).toEqual([]);
	});
});

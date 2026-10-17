// The person index against a real (in-memory) libSQL database, migrated as
// production is, so the name and shape here are the migration's.
import { describe, afterEach, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { acquireSyncLock, releaseSyncLock } from '../sync-lock.js';
import { VAN_ROSTER_BULK_LOCK } from './locks.js';
import {
	createRosterPersonIndex,
	dropRosterPersonIndex,
	restoreRosterPersonIndex,
	rosterPersonIndexExists,
} from './roster-index.js';

let db: ReturnType<typeof drizzle>;
let client: Client;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterEach(() => {
	client.close();
});

describe('roster person index', () => {
	it('is there after the migrations, and drops and builds again', async () => {
		expect(await rosterPersonIndexExists(db)).toBe(true);
		await dropRosterPersonIndex(db);
		expect(await rosterPersonIndexExists(db)).toBe(false);
		// Twice over is fine: a drain that died may have left either state.
		await dropRosterPersonIndex(db);
		await createRosterPersonIndex(db);
		await createRosterPersonIndex(db);
		expect(await rosterPersonIndexExists(db)).toBe(true);
	});

	it('is the index the person lookup uses', async () => {
		const plan = await client.execute(
			"EXPLAIN QUERY PLAN SELECT turf_id FROM van_turf_roster WHERE person_hash IN (x'00', x'01')",
		);
		expect(JSON.stringify(plan.rows)).toContain('van_turf_roster_person');
	});

	it('restores only what is missing', async () => {
		expect(await restoreRosterPersonIndex(db)).toBe(false);
		await dropRosterPersonIndex(db);
		expect(await restoreRosterPersonIndex(db)).toBe(true);
		expect(await rosterPersonIndexExists(db)).toBe(true);
	});

	it('leaves it down while a drain holds the bulk lock, and restores once it lets go', async () => {
		const token = await acquireSyncLock(db, VAN_ROSTER_BULK_LOCK, 60_000);
		await dropRosterPersonIndex(db);
		expect(await restoreRosterPersonIndex(db)).toBe(false);
		expect(await rosterPersonIndexExists(db)).toBe(false);
		await releaseSyncLock(db, VAN_ROSTER_BULK_LOCK, token!);
		expect(await restoreRosterPersonIndex(db)).toBe(true);
	});

	it('restores after a drain died and its bulk lock lapsed', async () => {
		await acquireSyncLock(db, VAN_ROSTER_BULK_LOCK, -1);
		await dropRosterPersonIndex(db);
		expect(await restoreRosterPersonIndex(db)).toBe(true);
	});
});

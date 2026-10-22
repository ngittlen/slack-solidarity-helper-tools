// The drain's check for a waiting sync, against a real (in-memory) database.
import { describe, afterEach, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { acquireSyncLock, releaseSyncLock } from '../sync-lock.js';
import { vanSyncWaiting, vanSyncWaitingLock } from './locks.js';

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

describe('vanSyncWaiting', () => {
	it('is true while a sync holds the marker, and only for its campaign', async () => {
		expect(await vanSyncWaiting(db, 1)).toBe(false);
		const token = await acquireSyncLock(db, vanSyncWaitingLock(1), 60_000);
		expect(await vanSyncWaiting(db, 1)).toBe(true);
		expect(await vanSyncWaiting(db, 2)).toBe(false);
		await releaseSyncLock(db, vanSyncWaitingLock(1), token!);
		expect(await vanSyncWaiting(db, 1)).toBe(false);
	});

	it('is false once a waiter that died has let its marker lapse', async () => {
		await acquireSyncLock(db, vanSyncWaitingLock(1), -1);
		expect(await vanSyncWaiting(db, 1)).toBe(false);
	});

	it('is true when it cannot tell, so the drain pauses rather than shut a sync out', async () => {
		client.close();
		expect(await vanSyncWaiting(db, 1)).toBe(true);
	});
});

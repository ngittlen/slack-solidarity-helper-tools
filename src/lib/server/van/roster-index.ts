// The roster's person index, set aside for a bulk roster load.
//
// van_turf_roster_person keys a random 16-byte digest, so every roster row
// lands on a random page of an index millions of rows long, far past what the
// database keeps cached. Measured on Turso in a drain (2026-10-16): ~4ms a
// roster row with the index, against ~0ms without — writer transactions fell
// from ~9s to 0.1s and the drain cleared twice the turfs per slice.
//
// Only the contact pull reads the index (turfsWithPeople in contact-sync.ts),
// and without it that lookup scans the roster rather than failing. So a drain
// with a big roster pass ahead drops it, and builds it again in one sorted
// pass at the end, which costs far less than keeping it up row by row.
//
// The drain holds VAN_ROSTER_BULK_LOCK while the index is down. A drain that
// dies without rebuilding it lets that lock lapse, and the next contact pull
// rebuilds it (restoreRosterPersonIndex). One that is still loading keeps the
// pull from rebuilding it under it.

import { sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { heldSyncLocks } from '../sync-lock.js';
import { VAN_ROSTER_BULK_LOCK } from './locks.js';

type Db = ReturnType<typeof drizzle>;

/** As drizzle/0052_contact_sync_incremental.sql creates it. */
const INDEX_NAME = 'van_turf_roster_person';

export async function rosterPersonIndexExists(db: Db): Promise<boolean> {
	const rows = await db.all(
		sql`select 1 from sqlite_master where type = 'index' and name = ${INDEX_NAME}`,
	);
	return rows.length > 0;
}

export async function dropRosterPersonIndex(db: Db): Promise<void> {
	await db.run(sql.raw(`DROP INDEX IF EXISTS \`${INDEX_NAME}\``));
}

/** Build it, whoever holds the bulk lock. For the drain that dropped it. */
export async function createRosterPersonIndex(db: Db): Promise<void> {
	await db.run(
		sql.raw(
			`CREATE INDEX IF NOT EXISTS \`${INDEX_NAME}\` ON \`van_turf_roster\` (\`person_hash\`)`,
		),
	);
}

/**
 * Build it if it is missing and no drain is loading rosters. Returns whether
 * it built it. A read when the index is there, which is almost always.
 */
export async function restoreRosterPersonIndex(db: Db): Promise<boolean> {
	if (await rosterPersonIndexExists(db)) return false;
	if ((await heldSyncLocks(db, [VAN_ROSTER_BULK_LOCK])).length > 0) return false;
	await createRosterPersonIndex(db);
	return true;
}

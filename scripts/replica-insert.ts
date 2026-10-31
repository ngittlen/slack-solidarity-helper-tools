// Writing one page of copied rows into db-replica.ts's local file, scrubbed on
// the way in (replica-scrub.ts). Its own module so it can be tested against a
// real database: db-replica.ts runs on import.

import type { Client, InValue, ResultSet } from '@libsql/client';
import type { OutsideIdScrubber } from './replica-scrub.js';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Tables keyed by a canvasser's name, where two real spellings of one Google
 * or Apple volunteer ("Jane Doe", "Jane D") both become the same stand-in and
 * would collide on the primary key. A duplicate is skipped and counted rather
 * than failing the whole run: the copy loses one of two per-day count rows for
 * that person, which a local test copy can live with.
 */
export const NAME_KEYED_TABLES = new Set(['door_knock_canvasser_daily']);

/** Insert one page of rows into the destination, in one transaction. Returns
 *  how many were skipped as duplicates (NAME_KEYED_TABLES only). */
export async function insertRows(
	local: Client,
	table: string,
	columns: readonly string[],
	rows: ResultSet['rows'],
	scrubber: OutsideIdScrubber,
): Promise<number> {
	const verb = NAME_KEYED_TABLES.has(table) ? 'INSERT OR IGNORE' : 'INSERT';
	const sql = `${verb} INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${columns
		.map(() => '?')
		.join(', ')})`;
	// One transaction per page: a commit per 200 rows was most of the run's
	// time on a Windows-mounted disk, and left the source connection idle long
	// enough for Turso to close it.
	if (rows.length === 0) return 0;
	const results = await local.batch(
		rows.map((row) => ({
			sql,
			args: scrubber.scrub(
				columns,
				columns.map((c) => (row[c] ?? null) as InValue),
			),
		})),
		'write',
	);
	return results.filter((result) => result.rowsAffected === 0).length;
}

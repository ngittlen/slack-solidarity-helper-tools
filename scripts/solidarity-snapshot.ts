/**
 * Compute and upsert a Solidarity signup snapshot for a single day. Defaults to
 * yesterday UTC; pass `--date YYYY-MM-DD` for an arbitrary day. Pass `--dry-run`
 * to print the rows without writing.
 *
 * Usage (from project root):
 *   npx tsx --env-file=.env.local scripts/solidarity-snapshot.ts
 *   npx tsx --env-file=.env.local scripts/solidarity-snapshot.ts --date 2026-04-15
 *   npx tsx --env-file=.env.local scripts/solidarity-snapshot.ts --dry-run
 *
 * Required env vars:
 *   SOLIDARITY_API_TOKEN,
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import { runSolidaritySnapshot } from '../src/lib/server/solidarity-snapshot.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dateIdx = args.indexOf('--date');
const DATE = dateIdx >= 0 ? args[dateIdx + 1] : undefined;

const SOLIDARITY_API_TOKEN = process.env.SOLIDARITY_API_TOKEN ?? '';
if (!SOLIDARITY_API_TOKEN) {
	console.error('Missing required env var: SOLIDARITY_API_TOKEN');
	process.exit(1);
}

const db = drizzle(createClient(dbConfig));

if (DRY_RUN) console.log('*** DRY RUN — no writes ***\n');

const result = await runSolidaritySnapshot(db, SOLIDARITY_API_TOKEN, {
	date: DATE,
	dryRun: DRY_RUN,
});

console.log(`Snapshot for ${result.date} (UTC ${result.rangeStartUnix}–${result.rangeEndUnix})`);
console.log(`  users scanned (since start of day): ${result.usersScanned}`);
console.log(`  users in range:                     ${result.usersInRange}`);
console.log(`  rows ${DRY_RUN ? 'computed' : 'upserted'}: ${result.rows.length}`);
for (const row of result.rows) {
	const label =
		row.chapterId === -1
			? '(no chapter)'
			: (row.chapterName ?? '(name not returned by /v1/chapters)');
	console.log(`    chapter ${row.chapterId} ${label}: ${row.count}`);
}

// Run ONCE against prod before deploying the 002-add-db-schema branch.
//
// Marks 0000_robust_nemesis as already applied so the migrator skips re-creating
// the `requests` and `sessions` tables (which prod already has from the old
// initDbSchema). 0001 (slack_joins + solidarity_daily_snapshots) and 0002
// (helped DROP COLUMN) will run normally on the next cold start.
//
// Usage:
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npx tsx scripts/baseline-drizzle.ts
//
// The script is idempotent — re-running is a no-op.

import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dbConfig } from '../bin/db-config.js';

const client = createClient(dbConfig);

const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
	entries: { tag: string; when: number }[];
};

const TAGS_TO_BASELINE = ['0000_robust_nemesis'];

await client.execute(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	hash TEXT NOT NULL,
	created_at NUMERIC
)`);

for (const tag of TAGS_TO_BASELINE) {
	const entry = journal.entries.find((e) => e.tag === tag);
	if (!entry) throw new Error(`Tag not found in journal: ${tag}`);

	const sql = readFileSync(`drizzle/${tag}.sql`, 'utf8');
	const hash = createHash('sha256').update(sql).digest('hex');

	const existing = await client.execute({
		sql: 'SELECT 1 FROM __drizzle_migrations WHERE hash = ?',
		args: [hash],
	});
	if (existing.rows.length > 0) {
		console.log(`[baseline] ${tag} already recorded — skipping`);
		continue;
	}

	await client.execute({
		sql: 'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
		args: [hash, entry.when],
	});
	console.log(`[baseline] inserted ${tag} (created_at=${entry.when})`);
}

console.log('[baseline] done');

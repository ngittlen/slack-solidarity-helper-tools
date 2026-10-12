import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// Migration 0071 renames contacted_doors to knocked_before_cut and clears it:
// the old count took in knocks since the cut too. Rehearsed the way a deploy
// runs it: the database migrated through 0070 with a count in it, then the
// real migrations applied on top.

const BEFORE = mkdtempSync(join(tmpdir(), 'drizzle-0070-'));
cpSync('drizzle', BEFORE, { recursive: true });
const journalPath = join(BEFORE, 'meta', '_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
journal.entries = journal.entries.filter((e) => e.idx <= 70);
writeFileSync(journalPath, JSON.stringify(journal));

afterAll(() => rmSync(BEFORE, { recursive: true, force: true }));

describe('migration 0071', () => {
	it('clears the old count, so the next scheduled sync recounts every turf', async () => {
		const client = createClient({ url: ':memory:' });
		const db = drizzle(client);
		await migrate(db, { migrationsFolder: BEFORE });
		await client.execute(
			`INSERT INTO van_turfs
			   (turf_id, van_map_route_id, map_region_id, folder_id, chapter_id, name, saved_list_id,
			    door_count, first_seen_at, last_seen_at, uncontacted_doors, contacted_doors)
			 VALUES (1, 1, 1, 1, 1, 'Turf', 900, 10, '2026-10-01', '2026-10-02', 4, 6)`,
		);

		await migrate(db, { migrationsFolder: 'drizzle' });

		const rows = await client.execute(
			'SELECT uncontacted_doors, knocked_before_cut FROM van_turfs WHERE turf_id = 1',
		);
		expect({ ...rows.rows[0] }).toEqual({ uncontacted_doors: 4, knocked_before_cut: null });
		client.close();
	});
});

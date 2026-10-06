import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// Migration 0063 copies production's google_volunteers rows into
// outside_volunteers with a hand-written INSERT … SELECT. Rehearsed the way a
// deploy runs it: the database migrated through 0062 with rows in it, then
// the real migrations applied on top.

const BEFORE = mkdtempSync(join(tmpdir(), 'drizzle-0062-'));
cpSync('drizzle', BEFORE, { recursive: true });
const journalPath = join(BEFORE, 'meta', '_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
journal.entries = journal.entries.filter((e) => e.idx <= 62);
writeFileSync(journalPath, JSON.stringify(journal));

afterAll(() => rmSync(BEFORE, { recursive: true, force: true }));

describe('migration 0063', () => {
	it('carries every Google record across, placeholder names as NULL, and keeps the old table', async () => {
		const client = createClient({ url: ':memory:' });
		const db = drizzle(client);
		await migrate(db, { migrationsFolder: BEFORE });
		await client.batch([
			"INSERT INTO google_volunteers VALUES ('google:1', 'a@x.org', 'Ana', '2026-10-01', '2026-10-02')",
			"INSERT INTO google_volunteers VALUES ('google:2', 'b@x.org', 'Google volunteer', '2026-10-01', '2026-10-03')",
		]);

		await migrate(db, { migrationsFolder: 'drizzle' });

		const rows = await client.execute('SELECT * FROM outside_volunteers ORDER BY user_id');
		expect(rows.rows.map((r) => ({ ...r }))).toEqual([
			{
				user_id: 'google:1',
				provider: 'google',
				email: 'a@x.org',
				is_private_email: 0,
				display_name: 'Ana',
				first_signed_in_at: '2026-10-01',
				last_signed_in_at: '2026-10-02',
			},
			{
				user_id: 'google:2',
				provider: 'google',
				email: 'b@x.org',
				is_private_email: 0,
				display_name: null,
				first_signed_in_at: '2026-10-01',
				last_signed_in_at: '2026-10-03',
			},
		]);
		// Dropped in a later release, not this one (see schema.ts).
		const old = await client.execute('SELECT count(*) AS n FROM google_volunteers');
		expect(Number(old.rows[0]!.n)).toBe(2);
		client.close();
	});
});

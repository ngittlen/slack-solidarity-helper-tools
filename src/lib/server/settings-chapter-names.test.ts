import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { refreshChapterNames } from './settings.js';

// Stored chapter names kept in step with Solidarity's. The case that prompted
// it: chapter 1307 was saved as "Berrien for Abdul", Solidarity renamed it
// "Southwest Michigan for Abdul", and /turfs — which labels chapters from the
// stored map — went on offering the old name.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const LIVE = [
	{ id: 1307, name: 'Southwest Michigan for Abdul' },
	{ id: 1310, name: 'Northeast Michigan for Abdul' },
	{ id: 1330, name: 'Washtenaw for Abdul' },
];

async function names(table: string, column: string) {
	const res = await client.execute(
		`SELECT chapter_id, ${column} AS name FROM ${table} ORDER BY chapter_id, ${column}`,
	);
	return res.rows.map((r) => [Number(r.chapter_id), String(r.name)]);
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	vi.spyOn(console, 'log').mockImplementation(() => {});
	await client.execute(
		`INSERT INTO chapter_channel_map (chapter_id, channel_id, name, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (1307, 'C1', 'Berrien for Abdul', 'U_ADMIN', 'Alice', 'x'),
		        (1307, 'C2', 'Berrien for Abdul', 'U_ADMIN', 'Alice', 'x'),
		        -- Two rows for one chapter that disagree with each other.
		        (1310, 'C3', 'Heartland for Abdul', 'U_ADMIN', 'Alice', 'x'),
		        (1310, 'C4', 'Northeast Michigan for Abdul', 'U_ADMIN', 'Alice', 'x'),
		        (1330, 'C5', 'Washtenaw for Abdul', 'U_ADMIN', 'Alice', 'x'),
		        -- Not in the live list: deleted in Solidarity, or a partial list.
		        (9999, 'C6', 'Retired chapter', 'U_ADMIN', 'Alice', 'x')`,
	);
	await client.execute(
		`INSERT INTO van_chapter_folders (campaign_id, chapter_id, folder_id, chapter_name, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (1, 1307, 1, 'Berrien for Abdul', 'U_ADMIN', 'Alice', 'x'),
		        (1, 1330, 2, 'Washtenaw for Abdul', 'U_ADMIN', 'Alice', 'x')`,
	);
});

describe('refreshChapterNames', () => {
	it('renames stale rows in the channel map and the folder mapping, and says which', async () => {
		const renames = await refreshChapterNames(db, LIVE);

		expect(renames).toEqual([
			{ chapterId: 1307, from: 'Berrien for Abdul', to: 'Southwest Michigan for Abdul' },
			{ chapterId: 1310, from: 'Heartland for Abdul', to: 'Northeast Michigan for Abdul' },
		]);
		expect(await names('chapter_channel_map', 'name')).toEqual([
			[1307, 'Southwest Michigan for Abdul'],
			[1307, 'Southwest Michigan for Abdul'],
			[1310, 'Northeast Michigan for Abdul'],
			[1310, 'Northeast Michigan for Abdul'],
			[1330, 'Washtenaw for Abdul'],
			[9999, 'Retired chapter'],
		]);
		expect(await names('van_chapter_folders', 'chapter_name')).toEqual([
			[1307, 'Southwest Michigan for Abdul'],
			[1330, 'Washtenaw for Abdul'],
		]);
	});

	it('changes nothing, and writes nothing, once the names agree', async () => {
		await refreshChapterNames(db, LIVE);
		expect(await refreshChapterNames(db, LIVE)).toEqual([]);
	});

	// A rename is not an edit of the mapping: the admin who set it up stays on it.
	it('leaves the audit columns as they were', async () => {
		await refreshChapterNames(db, LIVE);
		const res = await client.execute(
			'SELECT DISTINCT last_edited_by, last_edited_at FROM chapter_channel_map',
		);
		expect(res.rows.map((r) => [r.last_edited_by, r.last_edited_at])).toEqual([['U_ADMIN', 'x']]);
	});

	it('never blanks a name, whatever the live list says', async () => {
		expect(await refreshChapterNames(db, [{ id: 1307, name: '   ' }])).toEqual([]);
		expect(await refreshChapterNames(db, [])).toEqual([]);
		expect((await names('chapter_channel_map', 'name'))[0]).toEqual([1307, 'Berrien for Abdul']);
	});
});

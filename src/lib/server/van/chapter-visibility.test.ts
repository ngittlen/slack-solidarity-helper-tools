import { describe, afterEach, it, expect, beforeEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, isNull } from 'drizzle-orm';
import { vanTurfs } from '../schema.js';
import { foldersForChapter, visibleToChapter } from './chapter-visibility.js';

// The behaviour this exists for: one folder mapped to several chapters is
// visible to ALL of them. The old rule — match van_turfs.chapter_id — could not
// express that, because the catalog can only stamp one chapter per route.

let db: ReturnType<typeof drizzle>;
let client: Client;
const AT = '2026-09-20T00:00:00.000Z';

async function turf(
	turfId: number,
	folderId: number,
	chapterId = 71,
	campaignId = 1,
): Promise<void> {
	await client.execute(
		`INSERT INTO van_turfs (turf_id, campaign_id, van_map_route_id, map_region_id, folder_id, chapter_id, chapter_name, region_name, name, door_count, first_seen_at, last_seen_at)
		 VALUES (${turfId}, ${campaignId}, ${turfId}, 1, ${folderId}, ${chapterId}, 'Owning chapter', 'Region', 'Turf ${turfId}', 100, '${AT}', '${AT}')`,
	);
}

async function map(chapterId: number, folderId: number, campaignId = 1): Promise<void> {
	await client.execute(
		`INSERT INTO van_chapter_folders (campaign_id, chapter_id, folder_id, chapter_name, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (${campaignId}, ${chapterId}, ${folderId}, 'Chapter ${chapterId}', 'U_ADMIN', 'Alice', '${AT}')`,
	);
}

async function visible(chapterId: number | null): Promise<number[]> {
	const rows = await db
		.select({ turfId: vanTurfs.turfId })
		.from(vanTurfs)
		.where(and(visibleToChapter(chapterId), isNull(vanTurfs.retiredAt)));
	return rows.map((r) => r.turfId).sort((a, b) => a - b);
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

// Each test opens its own in-memory client. Closing it keeps one per test from
// leaking for the life of the worker — which never shows up while this file is
// run on its own.
afterEach(() => {
	client.close();
});

describe('visibleToChapter', () => {
	// Folder ids are VAN's, unique only within one committee. A chapter mapped
	// to campaign 1's folder 68295 must not see campaign 2's folder 68295.
	it("does not show another campaign's folder that happens to share an id", async () => {
		await client.execute(
			"INSERT INTO van_campaigns (id, credential_key, enabled, last_edited_by, last_edited_by_name, last_edited_at) VALUES (2, 'other', 1, 's', 's', 'x')",
		);
		await turf(100, 68295);
		await turf(900, 68295, 71, 2);
		await map(71, 68295);
		await map(72, 68295, 2);

		expect(await visible(71)).toEqual([100]);
		expect(await visible(72)).toEqual([900]);
		expect(await foldersForChapter(db, 72)).toEqual(['2:68295']);
	});

	it('shows a shared folder’s turf to every chapter mapped to it', async () => {
		await turf(100, 68295);
		await turf(200, 68295);
		for (const chapterId of [71, 72, 73]) await map(chapterId, 68295);

		expect(await visible(71)).toEqual([100, 200]);
		expect(await visible(72)).toEqual([100, 200]);
		expect(await visible(73)).toEqual([100, 200]);
	});

	it('does not leak turf from a folder a chapter is not mapped to', async () => {
		await turf(100, 68295);
		await turf(300, 68299);
		await map(71, 68295);
		await map(72, 68299);

		expect(await visible(71)).toEqual([100]);
		expect(await visible(72)).toEqual([300]);
	});

	it('ignores the chapter stamped on the row', async () => {
		// The label says 71; the mapping says 72 sees it. The mapping wins —
		// otherwise the first chapter to be written would own the folder.
		await turf(100, 68295, 71);
		await map(72, 68295);

		expect(await visible(71)).toEqual([]);
		expect(await visible(72)).toEqual([100]);
	});

	it('shows a chapter with no folders nothing at all', async () => {
		await turf(100, 68295);
		expect(await visible(71)).toEqual([]);
	});

	it('null means every chapter, for the organizer-wide view', async () => {
		await turf(100, 68295);
		await turf(300, 68299);
		await map(71, 68295);

		expect(await visible(null)).toEqual([100, 300]);
	});

	it('returns each turf once however many chapters share the folder', async () => {
		// A join would multiply the row; the subquery cannot.
		await turf(100, 68295);
		for (const chapterId of [71, 72, 73, 74]) await map(chapterId, 68295);

		expect(await visible(71)).toEqual([100]);
	});
});

// What the chapter rate limiter compares. It must name exactly the folders
// visibleToChapter matches on, or two chapters showing the same turf would
// still be charged separately — or worse, different turf would ride free.
describe('foldersForChapter', () => {
	it('lists every folder mapped to the chapter', async () => {
		await map(71, 68295);
		await map(71, 68299);
		await map(72, 68295);

		// Campaign-qualified: a folder id alone is ambiguous across campaigns.
		expect((await foldersForChapter(db, 71)).sort()).toEqual(['1:68295', '1:68299']);
		expect(await foldersForChapter(db, 72)).toEqual(['1:68295']);
	});

	it('is empty for a chapter with no folders', async () => {
		expect(await foldersForChapter(db, 71)).toEqual([]);
	});
});

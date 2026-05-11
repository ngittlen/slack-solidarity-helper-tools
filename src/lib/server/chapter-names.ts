// Chapter id → name lookup, borrowed from the denormalised
// solidarity_daily_snapshots table (written nightly by the Solidarity snapshot
// job). Shared by the weekly growth report and the dashboard signups endpoint;
// callers fall back to "Chapter #N" for any id missing from the map.
//
// Same import discipline as the modules that use it: no $env/$lib imports.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { solidarityDailySnapshots } from './schema.js';

export async function loadChapterNames(
	db: LibSQLDatabase<Record<string, unknown>>,
): Promise<Map<number, string>> {
	const rows = await db
		.select({
			chapterId: solidarityDailySnapshots.chapterId,
			chapterName: solidarityDailySnapshots.chapterName,
		})
		.from(solidarityDailySnapshots);
	const names = new Map<number, string>();
	for (const r of rows) {
		if (r.chapterName && !names.has(r.chapterId)) names.set(r.chapterId, r.chapterName);
	}
	return names;
}

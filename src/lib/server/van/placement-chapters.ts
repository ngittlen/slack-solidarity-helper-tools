// The chapters requested turf may be placed in: the ones the /turfs pickers
// offer, so placed turf never lands in a chapter nobody can open. Apart from
// turf-placement.ts, which stays free of settings so scripts and tests can
// run it.

import type { drizzle } from 'drizzle-orm/libsql';
import { loadSettings } from '../settings.js';
import { turfChapters } from '../../chapter-list.js';
import type { PlacementChapter } from './turf-placement.js';

type Db = ReturnType<typeof drizzle>;

export async function placementChapters(db: Db): Promise<PlacementChapter[]> {
	const settings = await loadSettings(db);
	return turfChapters(
		settings.chapterChannelMap,
		settings.turfHiddenChapterIds,
		settings.turfCustomChapters,
	).map((c) => ({ chapterId: c.chapterId, name: c.name }));
}

// Which turf a chapter can see.
//
// A folder may be mapped to several chapters, and then every turf in it belongs
// to all of them: a folder cut by region can span a dozen counties, and the
// chapters that canvass them overlap. So visibility is a property of the FOLDER
// MAPPING, read at query time, not of a chapter id stamped on the turf.
//
// `van_turfs.chapterId` still exists and still names one chapter — the first one
// mapped to that folder. It is a label for display and for anything that has to
// attribute a turf to a single chapter (the doors board, the activity feed);
// it is NOT what decides who may see or claim a turf. Using it for that is the
// bug this module replaces: the catalog wrote one row per route per chapter,
// every row keyed by route alone, so the last chapter written silently won and
// the other chapters saw none of that folder's turf.
//
// A correlated subquery rather than a join, so callers keep their existing
// `select()` shape and cannot accidentally multiply rows: a turf visible to
// three chapters is still one row.

import { eq, sql, type SQL } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfs, vanChapterFolders } from '../schema.js';

type Db = ReturnType<typeof drizzle>;

/**
 * A `where` fragment restricting turf to what `chapterId` may see.
 *
 * `null` means "every chapter" — the organizer-wide view — and returns
 * undefined so it composes with `and(...)` like any other optional filter.
 *
 * A chapter with no folders mapped sees nothing, which is correct and is also
 * the state every chapter starts in.
 */
export function visibleToChapter(chapterId: number | null): SQL | undefined {
	if (chapterId === null) return undefined;
	// The (campaign, folder) pair: folder ids are VAN's, unique only within one
	// committee, so a chapter mapped to campaign A's folder 7 must not see
	// campaign B's folder 7.
	return sql`(${vanTurfs.campaignId}, ${vanTurfs.folderId}) in (
		select ${vanChapterFolders.campaignId}, ${vanChapterFolders.folderId} from ${vanChapterFolders}
		where ${vanChapterFolders.chapterId} = ${chapterId}
	)`;
}

/**
 * A `where` fragment restricting turf to what ANY of `chapterIds` may see — the
 * turf at least one of them can claim. For a view that spans chapters but must
 * still respect which of them are offered (the signed-out /turfs teaser).
 *
 * An empty list sees nothing, like a chapter with no folders.
 */
export function visibleToAnyChapter(chapterIds: readonly number[]): SQL {
	if (chapterIds.length === 0) return sql`0`;
	return sql`(${vanTurfs.campaignId}, ${vanTurfs.folderId}) in (
		select ${vanChapterFolders.campaignId}, ${vanChapterFolders.folderId} from ${vanChapterFolders}
		where ${vanChapterFolders.chapterId} in (${sql.join(
			chapterIds.map((id) => sql`${id}`),
			sql`, `,
		)})
	)`;
}

/**
 * The folders `chapterId` sees turf from — what visibleToChapter matches on —
 * as `"<campaign>:<folder>"` keys, since a folder id alone is ambiguous across
 * campaigns.
 *
 * For the chapter rate limiter, which charges only for folders a user has not
 * already seen: two chapters sharing a folder show the same turf, and opening
 * the second should not cost a slot.
 */
export async function foldersForChapter(db: Db, chapterId: number): Promise<string[]> {
	const rows = await db
		.select({ campaignId: vanChapterFolders.campaignId, folderId: vanChapterFolders.folderId })
		.from(vanChapterFolders)
		.where(eq(vanChapterFolders.chapterId, chapterId));
	return rows.map((r) => `${r.campaignId}:${r.folderId}`);
}

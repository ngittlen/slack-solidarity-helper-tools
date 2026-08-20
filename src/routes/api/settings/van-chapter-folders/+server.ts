import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import {
	saveVanChapterFolders,
	deleteVanChapterFolders,
	type Editor,
} from '$lib/server/settings.js';

// Chapter → VAN folder mapping writes.
//
// One chapter per request, folder list submitted whole. This mapping is an
// INPUT to the catalog sync rather than something it discovers: a chapter with
// no folders here has no turf, and the sync does nothing until an admin fills
// it in. That is why it can be edited before a VAN key exists — it needs to be
// ready the day the key lands.
//
// Folder ids are typed in by hand from VAN, so they are validated as positive
// integers but NOT checked against VAN — there is no key to check with yet, and
// a wrong id simply yields no turf rather than anything unsafe. Story 2 adds a
// "this folder returned nothing" warning once the sync can look.
interface ChapterFoldersBody {
	action?: unknown;
	chapterId?: unknown;
	chapterName?: unknown;
	folderIds?: unknown;
}

const MAX_FOLDERS_PER_CHAPTER = 50;

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: ChapterFoldersBody;
	try {
		body = (await request.json()) as ChapterFoldersBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, chapterId, chapterName, folderIds } = body;
	if (action !== 'save' && action !== 'remove') {
		return json({ error: 'action must be "save" or "remove"' }, { status: 400 });
	}
	if (typeof chapterId !== 'number' || !Number.isInteger(chapterId) || chapterId <= 0) {
		return json({ error: 'chapterId must be a positive integer' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	if (action === 'remove') {
		await deleteVanChapterFolders(db, chapterId, editor);
		return json({ ok: true });
	}

	if (typeof chapterName !== 'string' || chapterName.trim() === '') {
		return json({ error: 'chapterName must be a non-empty string' }, { status: 400 });
	}
	if (!Array.isArray(folderIds)) {
		return json({ error: 'folderIds must be an array' }, { status: 400 });
	}
	if (folderIds.length > MAX_FOLDERS_PER_CHAPTER) {
		return json(
			{ error: `A chapter can map to at most ${MAX_FOLDERS_PER_CHAPTER} folders.` },
			{ status: 400 },
		);
	}
	for (const id of folderIds) {
		if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
			return json({ error: 'every folderId must be a positive integer' }, { status: 400 });
		}
	}

	await saveVanChapterFolders(
		db,
		{ chapterId, chapterName: chapterName.trim(), folderIds: folderIds as number[] },
		editor,
	);
	return json({ ok: true });
};

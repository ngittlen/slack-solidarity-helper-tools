import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import {
	deleteTurfHiddenChapter,
	loadSettings,
	saveTurfHiddenChapter,
	type Editor,
} from '$lib/server/settings.js';
import { chaptersFromChannelMap } from '$lib/chapter-list.js';

// Which chapters the /turfs pickers leave out: one add/remove of one chapter
// per request, shaped like /api/settings/zip-excluded-chapters.
//
// `add` checks the id against the chapter → channel map rather than the live
// Solidarity list: the map is what the pickers list, so a chapter not in it has
// nothing to hide. `remove` only shape-validates, so a hidden chapter since
// dropped from the map can always be un-hidden.
interface TurfHiddenChaptersBody {
	action?: unknown;
	chapterId?: unknown;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: TurfHiddenChaptersBody;
	try {
		body = (await request.json()) as TurfHiddenChaptersBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, chapterId } = body;
	if (action !== 'add' && action !== 'remove') {
		return json({ error: 'action must be "add" or "remove"' }, { status: 400 });
	}
	if (typeof chapterId !== 'number' || !Number.isInteger(chapterId)) {
		return json({ error: 'chapterId must be an integer' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	if (action === 'add') {
		const { chapterChannelMap } = await loadSettings(db);
		if (!chaptersFromChannelMap(chapterChannelMap).some((c) => c.chapterId === chapterId)) {
			return json(
				{ error: `Chapter ${chapterId} has no Slack channel mapped, so /turfs does not list it` },
				{ status: 400 },
			);
		}
		await saveTurfHiddenChapter(db, chapterId, editor);
		return json({ ok: true });
	}

	await deleteTurfHiddenChapter(db, chapterId, editor);
	return json({ ok: true });
};

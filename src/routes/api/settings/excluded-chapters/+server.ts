import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import {
	ensureExcludedChaptersSeeded,
	saveExcludedChapter,
	deleteExcludedChapter,
	type Editor,
} from '$lib/server/settings.js';
import { validateSolidarityChapter } from '$lib/server/settings-validation.js';

// Report-exclusion writes for the settings page: one add/remove of one
// Solidarity chapter per request. Excluded chapters are omitted from the
// weekly growth report and the dashboard signup charts — nothing else.
// `add` membership-checks the id against the cached live chapter list (503 on
// a transient list outage, 400 for an unknown id); `remove` only
// shape-validates so a stale exclusion (deleted chapter) can always be lifted.
interface ExcludedChaptersBody {
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

	let body: ExcludedChaptersBody;
	try {
		body = (await request.json()) as ExcludedChaptersBody;
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
		const result = await validateSolidarityChapter(SOLIDARITY_API_TOKEN, chapterId);
		if (!result.ok) {
			return json({ error: result.error }, { status: result.transient ? 503 : 400 });
		}
		await ensureExcludedChaptersSeeded(db);
		await saveExcludedChapter(db, { chapterId }, editor);
		return json({ ok: true });
	}

	await ensureExcludedChaptersSeeded(db);
	await deleteExcludedChapter(db, chapterId, editor);
	return json({ ok: true });
};

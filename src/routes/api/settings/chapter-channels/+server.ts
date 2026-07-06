import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import {
	ensureChapterChannelMapSeeded,
	saveChapterChannelEntries,
	deleteChapterChannelEntries,
	type Editor,
} from '$lib/server/settings.js';
import {
	validateSlackChannel,
	validateSolidarityChapter,
} from '$lib/server/settings-validation.js';

// Chapter ↔ Slack channel mapping writes for the settings page. One request
// applies a single add/remove of one channel across every selected chapter, so
// the UI's "add a chip while N chapters are selected" is one round-trip.
//
// `add` membership-checks the channel and every chapter against the cached
// live lists (settings-validation.ts) before writing; a transient list outage
// maps to 503 so the UI can offer "try again", a genuinely-unknown id to 400.
// `remove` only shape-validates — deleting a stale mapping must always work.
interface ChapterChannelsBody {
	action?: unknown;
	chapterIds?: unknown;
	channelId?: unknown;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let body: ChapterChannelsBody;
	try {
		body = (await request.json()) as ChapterChannelsBody;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const { action, chapterIds, channelId } = body;
	if (action !== 'add' && action !== 'remove') {
		return json({ error: 'action must be "add" or "remove"' }, { status: 400 });
	}
	if (
		!Array.isArray(chapterIds) ||
		chapterIds.length === 0 ||
		!chapterIds.every((id) => typeof id === 'number' && Number.isInteger(id))
	) {
		return json({ error: 'chapterIds must be a non-empty array of integers' }, { status: 400 });
	}
	if (typeof channelId !== 'string' || channelId.trim() === '') {
		return json({ error: 'channelId must be a non-empty string' }, { status: 400 });
	}

	const editor: Editor = {
		id: locals.session.slackUserId,
		name: locals.session.slackUserName ?? locals.session.slackUserId,
	};

	if (action === 'add') {
		// Validate the channel and every chapter in parallel (names come back from
		// the chapter validator — chapter_channel_map stores the name alongside
		// the id).
		const [channelResult, chapterResults] = await Promise.all([
			validateSlackChannel(slack, channelId),
			Promise.all(chapterIds.map((id) => validateSolidarityChapter(SOLIDARITY_API_TOKEN, id))),
		]);
		if (!channelResult.ok) {
			return json({ error: channelResult.error }, { status: channelResult.transient ? 503 : 400 });
		}
		const failed = chapterResults.find((r) => !r.ok);
		if (failed && !failed.ok) {
			return json({ error: failed.error }, { status: failed.transient ? 503 : 400 });
		}

		const chapters = chapterIds.map((chapterId, i) => {
			const result = chapterResults[i]!;
			return { chapterId, name: result.ok ? result.name : '' };
		});
		await ensureChapterChannelMapSeeded(db);
		await saveChapterChannelEntries(db, chapters, channelId, editor);
		return json({ ok: true });
	}

	await ensureChapterChannelMapSeeded(db);
	await deleteChapterChannelEntries(db, chapterIds, channelId, editor);
	return json({ ok: true });
};

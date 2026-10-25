import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { turfChapters } from '$lib/chapter-list.js';
import { db } from '$lib/server/db.js';
import { SLACK_SUPERUSER_ID } from '$lib/server/env.js';
import { loadSettings, loadVanBlockedIds } from '$lib/server/settings.js';
import { turfAccess } from '$lib/van/access.js';
import { recordChapterView } from '$lib/van/chapter-rate-limit.js';
import { recordRequest } from '$lib/van/request-budget.js';
import {
	chapterVisits,
	pruneRateLimitStores,
	turfRequests,
} from '$lib/server/van/rate-limit-store.js';
import { foldersForChapter } from '$lib/server/van/chapter-visibility.js';
import { loadWalkFinder } from '$lib/server/mentor-walks/panel.js';

// The walk cards for one chapter, as /turfs loads them (specs/015-mentor-
// walks, FR-015): for refreshing the cards and the map's walk markers without
// reloading the page (User Story 8, scenario 3). `walk` names the walk a
// message linked to, which is always among the cards, as the page's own
// `?walk=` has its load include it.
//
// The same gates as /api/turfs, against the same shared counters: this shows
// where mentors are meeting in a chapter, so it mustn't be a way around the
// page's chapter limiter. A blocked person, or anyone the feature is hidden
// from, gets `null`, as the page gives them (FR-039).

export const GET: RequestHandler = async ({ locals, url }) => {
	const session = locals.session;
	if (!session) return json({ error: 'Not signed in' }, { status: 401 });
	if (session.needsName) return json({ finder: null });

	const now = Date.now();
	pruneRateLimitStores(now);
	const budget = recordRequest(turfRequests, session.slackUserId, now, {
		exempt: session.isAdmin,
	});
	if (!budget.allowed) {
		return json(
			{ error: 'Too many requests. Slow down and try again shortly.' },
			{ status: 429, headers: { 'Retry-After': String(budget.retryAfterSeconds) } },
		);
	}

	const [settings, blockedIds] = await Promise.all([loadSettings(db), loadVanBlockedIds(db)]);
	const access = turfAccess(
		{ slackUserId: session.slackUserId, isAdmin: session.isAdmin },
		blockedIds,
		SLACK_SUPERUSER_ID,
	);
	if (!access.allowed) return json({ finder: null });

	const chapterId = Number(url.searchParams.get('chapter'));
	const known = turfChapters(
		settings.chapterChannelMap,
		settings.turfHiddenChapterIds,
		settings.turfCustomChapters,
	).some((c) => c.chapterId === chapterId);
	if (!Number.isInteger(chapterId) || !known) {
		return json({ error: 'Unknown chapter' }, { status: 400 });
	}

	const limit = recordChapterView(chapterVisits, session.slackUserId, chapterId, now, {
		exempt: session.isAdmin,
		folderIds: await foldersForChapter(db, chapterId),
	});
	if (!limit.allowed) {
		return json(
			{ error: 'Too many chapters opened recently. Try again shortly.' },
			{ status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
		);
	}

	const finder = await loadWalkFinder(db, {
		viewer: session,
		settings,
		blocked: false,
		now: new Date(now),
		chapterId,
		linkedWalkId: url.searchParams.get('walk'),
	});
	return json({ finder });
};

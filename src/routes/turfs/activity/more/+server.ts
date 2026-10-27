import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { parseCursor } from '$lib/van/turf-activity.js';
import { activityFilters, loadActivityPage } from '../activity-page.js';

// GET → the page of events after the cursor, filtered like the page. Fetched
// by the activity page as the organizer scrolls toward the end of what it has
// loaded.
//
// The cursor is the oldest event the page holds: its time as `before` and its
// id as `after`. `now` is the page's own load time, sent back by the browser,
// so the period's lower bound and each "ago" label match the rows already on
// screen.

function parseInstant(raw: string | null): Date | null {
	if (!raw) return null;
	const date = new Date(raw);
	return Number.isNaN(date.getTime()) ? null : date;
}

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) return json({ error: 'unauthenticated' }, { status: 401 });
	if (!locals.session.isAdmin) return json({ error: 'unauthorized' }, { status: 403 });

	const now = parseInstant(url.searchParams.get('now'));
	const after = parseCursor(url.searchParams.get('before'), url.searchParams.get('after'));
	if (!now || !after) return json({ error: 'bad cursor' }, { status: 400 });

	const { query } = await activityFilters(db, url, now);
	const page = await loadActivityPage(db, query, now, { after });
	return json(page);
};

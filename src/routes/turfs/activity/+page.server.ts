import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import { hasAnyTurf, loadActivityCounts } from '$lib/server/van/activity-store.js';
import { totalEvents } from '$lib/van/turf-activity.js';
import { activityFilters, loadActivityPage } from './activity-page.js';

export type { ActivityEventView } from './activity-page.js';

// Turf checkout history, for organizers.
//
// The organizer side of a line the volunteer page draws deliberately. /turfs
// refuses an "all chapters" view and hides holder names — turf-status.ts
// collapses `held-by-other` and nulls `heldBy` for non-admins — because a
// volunteer cannot act on that and has no reason to learn who is knocking which
// block. This page is the other side of it: names are shown, every chapter is
// the default, and the gate is admin-only. That asymmetry is the design, not a
// gap in it.
//
// Two things are still withheld, from admins as much as anyone:
//
//   - The MiniVAN list number. It is the credential issued to whoever holds the
//     turf, and an admin is not the holder. activity-store.ts never selects it,
//     so it cannot reach the payload by omission.
//   - Anything per-voter. Nothing of the kind is stored in the first place, but
//     the test asserts it rather than trusting the pipeline upstream to stay
//     that way.
//
// Timestamps are formatted here rather than in the component. Formatting in the
// browser would render each row in the reader's own timezone — two organizers
// comparing notes would see different times for one event — and would risk a
// hydration mismatch on every row.

export const load: PageServerLoad = async ({ locals, url }) => {
	// Checked here, not just in +layout.server.ts — layout and page loads run
	// concurrently, so an unauthenticated request still reaches this function.
	// One check covers both cases: a missing session and a signed-in non-admin
	// both get the same bare 302, per the constitution's Principle I.
	if (!locals.session?.isAdmin) redirect(302, '/');

	// One `now` for both queries, so the counts and the list describe the same
	// window even if a claim lands between them. Named because the per-event
	// "ago" labels measure against it too, and a second `new Date()` would let
	// the window and the labels disagree.
	const now = new Date();
	// Validated against what exists rather than trusted from the query string,
	// the same way /turfs does it: an unknown id falls back to "every chapter"
	// instead of erroring, because a mistyped URL should show a page.
	const { chapters, chapter, period, campaigns, search, query } = await activityFilters(
		db,
		url,
		now,
	);

	const [counts, page, anyTurf] = await Promise.all([
		loadActivityCounts(db, query),
		loadActivityPage(db, query, now),
		hasAnyTurf(db),
	]);

	return {
		pageTitle: 'Turf activity',
		chapters,
		chapter,
		campaigns: campaigns.campaigns,
		campaign: campaigns.campaign,
		// Badge text per campaign id, for rows whose campaign shows one.
		campaignBadges: campaigns.badges,
		period,
		search,
		events: page.events,
		dayLabels: page.dayLabels,
		hasMore: page.hasMore,
		// What the "more" endpoint measures later pages against, so their period
		// and "ago" labels match the rows already on screen.
		now: now.toISOString(),
		counts,
		// The exact total across the period, counted in SQL — so "showing N of M"
		// stays honest while the list pages. Both halves describe the same set,
		// which is why it is phrased that way rather than as "M more".
		total: totalEvents(counts),
		anyTurf,
	};
};

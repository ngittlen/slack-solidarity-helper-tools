// What the page load and the "more" endpoint share: reading the filters off
// the URL, and turning a range into a page of formatted events. One copy, so a
// page fetched on scroll is filtered and labelled exactly like the first.

import type { drizzle } from 'drizzle-orm/libsql';
import { loadSettings } from '$lib/server/settings.js';
import { chaptersFromChannelMap } from '$lib/chapter-list.js';
import { loadActivityRows, type ActivityQuery } from '$lib/server/van/activity-store.js';
import {
	activityEvents,
	compareEvents,
	EVENTS_PER_PAGE,
	parsePeriod,
	rangeFor,
	type ActivityCursor,
	type ActivityEvent,
} from '$lib/van/turf-activity.js';
import { campaignDayKey, campaignDayLabel, campaignTimeLabel } from '$lib/campaign-time.js';
import { campaignFilter } from '$lib/server/van/campaigns.js';
import { relativeSince } from '$lib/components/settings/format-relative.js';
import { loadHolderAccounts } from '$lib/server/outside-volunteers.js';
import type { HolderAccount } from '$lib/holder-account.js';

type Db = ReturnType<typeof drizzle>;

export interface ActivityEventView extends ActivityEvent {
	/** The Slack, Google or Apple mark beside the name, and an outside holder's email. */
	account: HolderAccount | null;
	/** Campaign-local grouping key, `YYYY-MM-DD`. */
	dayKey: string;
	/** Campaign-local time of day, e.g. "9:41 AM". */
	timeLabel: string;
	/** "20m ago", against the page's `now`. Formatted on the server for the same
	 *  reason `timeLabel` is: computed from `Date.now()` at render time, SSR and
	 *  hydration would disagree on every row. */
	agoLabel: string;
}

export interface ActivityPage {
	events: ActivityEventView[];
	/** Day heading per `dayKey` present in `events`. */
	dayLabels: Record<string, string>;
	/** Whether older events exist below this page. */
	hasMore: boolean;
}

/** Longest search the history accepts. A turf or volunteer name is far
 *  shorter; the cap keeps a pasted paragraph out of four LIKE scans. */
const MAX_SEARCH = 100;

/**
 * The chapter, campaign, period and search on the URL, each validated against
 * what exists, and the query they make with `now` as the range's end. An
 * unknown chapter or campaign falls back to "every", and a junk period to the
 * default, because a mistyped URL should show a page.
 */
export async function activityFilters(db: Db, url: URL, now: Date) {
	const [settings, campaigns] = await Promise.all([
		loadSettings(db),
		campaignFilter(db, url.searchParams.get('campaign')),
	]);
	// Deduplicated, not just sorted: the channel map lists a chapter once per
	// channel, and the picker's keyed `{#each}` throws on a repeated chapter.
	// See chaptersFromChannelMap.
	const chapters = chaptersFromChannelMap(settings.chapterChannelMap, settings.turfCustomChapters);
	const requested = Number(url.searchParams.get('chapter'));
	const chapter = chapters.find((c) => c.chapterId === requested) ?? null;
	const period = parsePeriod(url.searchParams.get('days'));
	const search = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_SEARCH);
	const query: ActivityQuery = {
		chapterId: chapter?.chapterId ?? null,
		campaignId: campaigns.campaign?.id ?? null,
		range: rangeFor(period, now),
		search,
	};
	return { chapters, chapter, period, campaigns, search, query };
}

/**
 * The newest `pageSize` events in `query.range`, formatted for the page — or,
 * with `after`, the next `pageSize` following that event.
 *
 * `now` is the first page's load time on every page, so each "ago" label is
 * measured against the same instant as the rows already on screen.
 */
export async function loadActivityPage(
	db: Db,
	query: ActivityQuery,
	now: Date,
	{
		after = null,
		pageSize = EVENTS_PER_PAGE,
	}: { after?: ActivityCursor | null; pageSize?: number } = {},
): Promise<ActivityPage> {
	// One row past the page, to know whether another page exists. The newest
	// N + 1 rows still carry the newest N events — see loadActivityRows.
	const limit = pageSize + 1;
	let all: ActivityEvent[];
	let moreRows: boolean;
	if (!after) {
		const rows = await loadActivityRows(db, { ...query, limit });
		all = activityEvents(rows, query.range);
		moreRows = rows.length > pageSize;
	} else {
		// Two reads, because a row range cannot split a millisecond: the events
		// stamped in the cursor's own millisecond that sort after it, then
		// everything strictly older. Ending the second range at the cursor alone
		// would skip a second event in that millisecond; ending it a millisecond
		// later would hand back ones already shown, and a page of nothing but
		// those would read as the end of the history.
		const tied = { start: after.at, end: new Date(Date.parse(after.at) + 1).toISOString() };
		const older = { ...query.range, end: after.at };
		const [tiedRows, olderRows] = await Promise.all([
			// Rows tied on time sort by checkout id, newest first, so the ones the
			// cursor has not passed are its own and those below it. Bounded in SQL
			// so the limit counts only those.
			loadActivityRows(db, { ...query, range: tied, limit, throughCheckout: after.checkoutId }),
			loadActivityRows(db, { ...query, range: older, limit }),
		]);
		all = [
			...activityEvents(tiedRows, tied).filter((event) => compareEvents(event, after) > 0),
			...activityEvents(olderRows, older),
		];
		moreRows = tiedRows.length > pageSize || olderRows.length > pageSize;
	}
	const page = all.slice(0, pageSize);

	const accounts = await loadHolderAccounts(
		db,
		page.map((event) => event.slackUserId),
	);
	const events: ActivityEventView[] = page.map((event) => ({
		...event,
		account: accounts.get(event.slackUserId) ?? null,
		dayKey: campaignDayKey(event.at),
		timeLabel: campaignTimeLabel(event.at),
		agoLabel: relativeSince(event.at, now),
	}));

	// Day headings come from the events themselves, so a day with no activity
	// simply does not appear.
	const dayLabels: Record<string, string> = {};
	for (const event of events) {
		if (!dayLabels[event.dayKey]) dayLabels[event.dayKey] = campaignDayLabel(event.at);
	}

	return {
		events,
		dayLabels,
		hasMore: moreRows || all.length > pageSize,
	};
}

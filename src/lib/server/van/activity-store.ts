// Reading turf checkout history out of the ledger.
//
// Two queries, deliberately: an aggregate that counts every event in the
// period, and a detail query that fetches only the rows the page will render.
// Counting in SQL rather than by expanding rows in memory is what lets the
// page say "showing 100 of 1,240" honestly while it pages — the total is exact
// however many pages have loaded, and neither number depends on how many rows
// we happened to fetch.
//
// The chapter filter IS the join. `van_turf_checkouts` has no chapter column
// (schema.ts keeps the ledger narrow and denormalises chapter onto `van_turfs`
// instead), so every query here joins the turf row and filters there.
//
// Retired turf is deliberately NOT excluded. A turf VAN no longer has still
// happened, and a history that dropped it would quietly rewrite the record of a
// canvass that really took place.

import { and, desc, eq, gte, lt, lte, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import {
	emptyCounts,
	EVENTS_PER_PAGE,
	type ActivityCounts,
	type ActivityRange,
	type ActivityRow,
} from '../../van/turf-activity.js';
import { visibleToChapter } from './chapter-visibility.js';
import { inCampaign } from './campaigns.js';

type Db = ReturnType<typeof drizzle>;

/** Reasons that mean the claim was ended by something other than the
 *  volunteer. Mirrors `endKind` in turf-activity.ts — the two must agree, or
 *  the summary counts and the list below them tell different stories. */
const INVOLUNTARY_REASONS = ['expired', 'blocked', 'retired', 'walked-out'] as const;

export interface ActivityQuery {
	/** Null means every chapter. Admin-only page, so an unscoped read is the
	 *  intended default rather than a leak — see the route's header. */
	chapterId: number | null;
	/** One VAN campaign's turf; null or omitted means every campaign. */
	campaignId?: number | null;
	range: ActivityRange;
	/** Text the turf, its region, its chapter or the volunteer's name must
	 *  contain, ignoring case. Empty or omitted matches everything. */
	search?: string;
}

/** Is this timestamp column inside the range? Null columns are excluded by the
 *  comparison itself, which is what we want: an unreleased claim has no
 *  `released_at` and so contributes no release event. */
function stampInRange(column: AnyColumn, range: ActivityRange): SQL {
	const upper = lt(column, range.end);
	return (range.start === null ? upper : and(gte(column, range.start), upper)) as SQL;
}

/** The three stamps an event can come from. */
const STAMPS = [
	vanTurfCheckouts.claimedAt,
	vanTurfCheckouts.releasedAt,
	vanTurfCheckouts.completedAt,
] as const;

/** `search` as a LIKE over what an organizer reads in a row. SQLite's LIKE
 *  ignores case for ASCII; `%`, `_` and the escape itself are escaped so they
 *  match literally. */
function matchesSearch(search: string | undefined): SQL | undefined {
	const text = search?.trim();
	if (!text) return undefined;
	const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	return or(
		...[
			vanTurfs.name,
			vanTurfs.regionName,
			vanTurfs.chapterName,
			vanTurfCheckouts.slackUserName,
		].map((column) => sql`${column} like ${pattern} escape '\\'`),
	);
}

/** The chapter, campaign and search filters — everything but the range. */
function filtersWhere(query: ActivityQuery): SQL | undefined {
	return and(
		visibleToChapter(query.chapterId),
		inCampaign(query.campaignId),
		matchesSearch(query.search),
	);
}

/** Rows touched by this range at all — any of the three stamps inside it. */
function scopeWhere(query: ActivityQuery): SQL {
	const touched = or(...STAMPS.map((column) => stampInRange(column, query.range))) as SQL;
	return and(filtersWhere(query), touched) as SQL;
}

/** `sum(case when … then 1 else 0 end)`, which counts events rather than rows —
 *  the distinction that matters, since one row can carry two of them. */
function countWhen(condition: SQL): SQL<number> {
	return sql<number>`sum(case when ${condition} then 1 else 0 end)`;
}

/**
 * How many of each event happened in the period.
 *
 * Exact, and independent of how many pages of the list have loaded. A row claimed and completed
 * inside the window is counted twice here, once under each kind, which is the
 * same fan-out `activityEvents` performs — the two are the same rule expressed
 * in SQL and in TypeScript, so they are tested against each other.
 */
export async function loadActivityCounts(db: Db, query: ActivityQuery): Promise<ActivityCounts> {
	const released = stampInRange(vanTurfCheckouts.releasedAt, query.range);
	const involuntary = sql`${vanTurfCheckouts.releaseReason} in (${sql.join(
		INVOLUNTARY_REASONS.map((r) => sql`${r}`),
		sql`, `,
	)})`;

	const [row] = await db
		.select({
			claimed: countWhen(stampInRange(vanTurfCheckouts.claimedAt, query.range)),
			completed: countWhen(stampInRange(vanTurfCheckouts.completedAt, query.range)),
			// Anything not on the involuntary list — 'volunteer', 'admin', a NULL,
			// or a reason a later migration adds — reads as a deliberate hand-back,
			// matching endKind's default branch.
			givenBack: countWhen(
				sql`${released} and (${vanTurfCheckouts.releaseReason} is null or not ${involuntary})`,
			),
			expired: countWhen(sql`${released} and ${vanTurfCheckouts.releaseReason} = 'expired'`),
			blocked: countWhen(sql`${released} and ${vanTurfCheckouts.releaseReason} = 'blocked'`),
			retired: countWhen(sql`${released} and ${vanTurfCheckouts.releaseReason} = 'retired'`),
			walkedOut: countWhen(sql`${released} and ${vanTurfCheckouts.releaseReason} = 'walked-out'`),
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.turfId, vanTurfs.turfId))
		.where(scopeWhere(query));

	// `sum()` over no rows is NULL, not 0.
	return {
		...emptyCounts(),
		claimed: Number(row?.claimed ?? 0),
		completed: Number(row?.completed ?? 0),
		'given-back': Number(row?.givenBack ?? 0),
		expired: Number(row?.expired ?? 0),
		blocked: Number(row?.blocked ?? 0),
		retired: Number(row?.retired ?? 0),
		'walked-out': Number(row?.walkedOut ?? 0),
	};
}

/** A row's newest stamp below `end` — the newest event of its that a page
 *  ending there can show. '' when it has none. */
function newestBelow(row: ActivityRow, end: string): string {
	let newest = '';
	for (const stamp of [row.claimedAt, row.releasedAt, row.completedAt]) {
		if (stamp !== null && stamp < end && stamp > newest) newest = stamp;
	}
	return newest;
}

/**
 * The checkout rows behind the most recent events: the `limit` rows whose
 * newest stamp *below the range's end* is newest, then by checkout id, so
 * paging is stable.
 *
 * The bound matters once the page fetches older events with `end` set to a
 * cursor: a row claimed before the cursor and completed after it has to sort by
 * its claim, the newest event this page can show. Sorting by the completion
 * would rank it above rows whose events are really newer, and push one of them
 * off the page.
 *
 * Read as one query per stamp, each the newest `limit` rows by that stamp in
 * the range, merged here. Each walks its own index and stops after `limit`
 * rows, so a page deep in a long history costs about what the first one does;
 * a single query ordered by the newest of three stamps would have to sort
 * every row in the period first. The merge loses nothing: a row in the top
 * `limit` overall has fewer than `limit` rows ahead of it by the stamp that
 * puts it there, so that stamp's query returns it.
 *
 * **Fetching `limit` rows is enough for `limit` events**, which reads like an
 * off-by-one until you follow it: rows are sorted by their newest in-range
 * event, and every row yields at least one, so the N newest events are all
 * carried by the N newest rows. A row further down the ordering cannot hold an
 * event newer than one already in hand.
 */
export async function loadActivityRows(
	db: Db,
	query: ActivityQuery & {
		limit?: number;
		/** Only checkouts with this id or lower — those that sort at or after
		 *  it among rows tied on time. */
		throughCheckout?: number;
	},
): Promise<ActivityRow[]> {
	const limit = query.limit ?? EVENTS_PER_PAGE;
	const filters = and(
		filtersWhere(query),
		query.throughCheckout === undefined
			? undefined
			: lte(vanTurfCheckouts.id, query.throughCheckout),
	);

	const byStamp = await Promise.all(
		STAMPS.map((stamp) =>
			db
				.select({
					checkoutId: vanTurfCheckouts.id,
					turfId: vanTurfCheckouts.turfId,
					slackUserId: vanTurfCheckouts.slackUserId,
					slackUserName: vanTurfCheckouts.slackUserName,
					claimedAt: vanTurfCheckouts.claimedAt,
					releasedAt: vanTurfCheckouts.releasedAt,
					completedAt: vanTurfCheckouts.completedAt,
					releaseReason: vanTurfCheckouts.releaseReason,
					confirmedDoorDelta: vanTurfCheckouts.confirmedDoorDelta,
					reportedPercent: vanTurfCheckouts.reportedPercent,
					// From the turf row. Note what is NOT selected: printedListNumber is
					// the holder's credential and an admin is not the holder, so it never
					// enters the payload in the first place.
					name: vanTurfs.name,
					regionName: vanTurfs.regionName,
					chapterId: vanTurfs.chapterId,
					chapterName: vanTurfs.chapterName,
					campaignId: vanTurfs.campaignId,
					doorCount: vanTurfs.doorCount,
				})
				.from(vanTurfCheckouts)
				.innerJoin(vanTurfs, eq(vanTurfCheckouts.turfId, vanTurfs.turfId))
				.where(and(filters, stampInRange(stamp, query.range)))
				.orderBy(desc(stamp), desc(vanTurfCheckouts.id))
				.limit(limit),
		),
	);

	const merged = new Map<number, ActivityRow>();
	for (const rows of byStamp) for (const row of rows) merged.set(row.checkoutId, row);
	const end = query.range.end;
	return [...merged.values()]
		.map((row) => ({ row, newest: newestBelow(row, end) }))
		.sort((a, b) =>
			a.newest !== b.newest ? (a.newest < b.newest ? 1 : -1) : b.row.checkoutId - a.row.checkoutId,
		)
		.slice(0, limit)
		.map(({ row }) => row);
}

/** Whether any turf exists at all, so the page can tell "nothing happened this
 *  week" apart from "no turf has ever been loaded" — which, with no VAN key
 *  yet, is the state anyone actually hits today. */
export async function hasAnyTurf(db: Db): Promise<boolean> {
	const rows = await db.select({ turfId: vanTurfs.turfId }).from(vanTurfs).limit(1);
	return rows.length > 0;
}

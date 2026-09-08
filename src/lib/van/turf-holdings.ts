// What turf is out right now, and which of it needs an organizer's attention.
//
// The companion to turf-activity.ts. That one answers "what happened" from the
// terminal stamps on a checkout; this one answers "what is happening" from the
// rows that have no terminal stamp yet. Same ledger, opposite end.
//
// Pure — no DB, no clock of its own — so the rules an organizer would ask about
// ("why is that one flagged?") are answerable from a unit test.
//
// The one distinction worth stating up front, because getting it wrong would
// make the page actively misleading: **a null confirmedDoorDelta is not a zero
// one.** Null means the post-completion refresh has not run — which today is
// every completion, since Story 5.6 is still blocked on the VAN key. Zero means
// it ran and the door count did not move, which is the signature of a volunteer
// who never synced MiniVAN. Treating null as zero would accuse every volunteer
// on the board of something no one has checked.

import { hoursRemaining, isActive, type ClaimSnapshot } from './checkout.js';
import { EXPIRY_WARNING_LEAD_HOURS } from './expiry-warning.js';

/** The joined `van_turf_checkouts` + `van_turfs` columns this module reads. */
export interface HoldingRow extends ClaimSnapshot {
	checkoutId: number;
	turfName: string;
	regionName: string;
	chapterId: number;
	chapterName: string;
	doorCount: number;
	/** When the T-6h warning DM landed, or null if it has not (yet) been sent. */
	expiryWarnedAt: string | null;
}

/**
 * How close a live claim is to lapsing.
 *
 * Three bands, not a number, because the page's job is triage: an organizer
 * scanning twenty rows needs to know which two to chase, not that one has
 * 11.4 hours left.
 */
export type HoldingUrgency = 'expiring' | 'due-soon' | 'fine';

export interface Holding {
	checkoutId: number;
	mapRouteId: number;
	turfName: string;
	regionName: string;
	chapterId: number;
	chapterName: string;
	doorCount: number;
	slackUserId: string;
	slackUserName: string;
	claimedAt: string;
	expiresAt: string;
	hoursLeft: number;
	/** Whole hours since the claim was made. How long they have had it. */
	hoursHeld: number;
	urgency: HoldingUrgency;
	/** Whether the volunteer has already been warned. An expiring claim with no
	 *  warning sent is the one an organizer should chase personally. */
	warned: boolean;
}

/**
 * Anything lapsing within this many hours is "expiring".
 *
 * Deliberately the same window the warning DM uses, so the board and the DM
 * agree about what "about to lapse" means. An organizer looking at a row
 * flagged red should be able to assume the volunteer has heard from us — and
 * when they have not, `warned` says so.
 */
export const EXPIRING_WITHIN_HOURS = EXPIRY_WARNING_LEAD_HOURS;

/** A softer band, for turf worth watching but not yet worth a message. */
export const DUE_SOON_WITHIN_HOURS = 24;

export function urgencyFor(hoursLeft: number): HoldingUrgency {
	if (hoursLeft <= EXPIRING_WITHIN_HOURS) return 'expiring';
	if (hoursLeft <= DUE_SOON_WITHIN_HOURS) return 'due-soon';
	return 'fine';
}

/** Whole hours between two stamps, floored at zero. Unparseable reads as zero
 *  rather than throwing — a corrupt row should render oddly, not take the
 *  organizer's page down. */
function hoursBetween(fromIso: string, now: Date): number {
	const from = Date.parse(fromIso);
	if (Number.isNaN(from)) return 0;
	return Math.max(0, Math.floor((now.getTime() - from) / 3_600_000));
}

/**
 * Live claims, most urgent first.
 *
 * `isActive` is reused rather than re-derived: it already knows that a released
 * or completed row is not a holding, and that an unparseable expiry counts as
 * long past. A board that showed turf someone gave back an hour ago would send
 * an organizer chasing a volunteer who did the right thing.
 */
export function currentHoldings(rows: readonly HoldingRow[], now: Date): Holding[] {
	const holdings = rows
		.filter((row) => isActive(row, now))
		.map((row) => {
			const hoursLeft = hoursRemaining(row, now);
			return {
				checkoutId: row.checkoutId,
				mapRouteId: row.mapRouteId,
				turfName: row.turfName,
				regionName: row.regionName,
				chapterId: row.chapterId,
				chapterName: row.chapterName,
				doorCount: row.doorCount,
				slackUserId: row.slackUserId,
				slackUserName: row.slackUserName,
				claimedAt: row.claimedAt,
				expiresAt: row.expiresAt,
				hoursLeft,
				hoursHeld: hoursBetween(row.claimedAt, now),
				urgency: urgencyFor(hoursLeft),
				warned: row.expiryWarnedAt !== null,
			};
		});

	// Soonest to lapse first — the board is read top-down when someone is
	// deciding who to chase. Checkout id breaks a tie so the order is stable
	// between refreshes rather than shuffling.
	holdings.sort((a, b) => a.hoursLeft - b.hoursLeft || a.checkoutId - b.checkoutId);
	return holdings;
}

/** How many volunteers hold turf right now — not how many turfs are out. Someone
 *  holding two counts once, which is the number an organizer means by "how many
 *  people are out today". */
export function distinctHolders(holdings: readonly Holding[]): number {
	return new Set(holdings.map((h) => h.slackUserId)).size;
}

export interface HoldingSummary {
	turfsOut: number;
	holders: number;
	doorsOut: number;
	expiring: number;
	/** Expiring turf whose holder has NOT been warned. The number that means
	 *  someone has to pick up a phone. */
	expiringUnwarned: number;
}

export function summarise(holdings: readonly Holding[]): HoldingSummary {
	const expiring = holdings.filter((h) => h.urgency === 'expiring');
	return {
		turfsOut: holdings.length,
		holders: distinctHolders(holdings),
		doorsOut: holdings.reduce((sum, h) => sum + h.doorCount, 0),
		expiring: expiring.length,
		expiringUnwarned: expiring.filter((h) => !h.warned).length,
	};
}

// ---------------------------------------------------------------------------
// Completions that look like a missed sync
// ---------------------------------------------------------------------------

export interface CompletionRow {
	checkoutId: number;
	mapRouteId: number;
	turfName: string;
	regionName: string;
	chapterId: number;
	chapterName: string;
	slackUserId: string;
	slackUserName: string;
	completedAt: string;
	/** Doors that left the turf between claim and the post-completion refresh.
	 *  NULL until that refresh has run — see the module header. */
	confirmedDoorDelta: number | null;
}

export interface SuspectCompletion extends CompletionRow {
	confirmedDoorDelta: number;
}

/**
 * Completions where the door count did not move.
 *
 * The volunteer marked the turf walked, VAN refreshed, and nothing changed —
 * which almost always means MiniVAN was never synced, so the canvass results
 * are sitting on a phone. That is the entire sync-back verification story
 * (plan.md 5.6), and this is where an organizer sees it.
 *
 * **Only rows whose delta has actually been measured.** A null is excluded, not
 * counted as zero: it means the check has not run, which today is every
 * completion, and listing them all as suspect would be an accusation nobody has
 * evidence for.
 */
export function suspectCompletions(rows: readonly CompletionRow[]): SuspectCompletion[] {
	return rows
		.filter((row): row is SuspectCompletion => row.confirmedDoorDelta === 0)
		.sort((a, b) => (a.completedAt < b.completedAt ? 1 : a.completedAt > b.completedAt ? -1 : 0));
}

/** Whether any completion has had its delta measured at all. Drives the
 *  difference between "nothing to worry about" and "we have not checked yet",
 *  which are opposite messages and must not share an empty state. */
export function anyDeltaMeasured(rows: readonly CompletionRow[]): boolean {
	return rows.some((row) => row.confirmedDoorDelta !== null);
}

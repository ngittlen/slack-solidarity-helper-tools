// The nudge that stops turf being lost quietly.
//
// A claim lapses after its TTL and the nightly sweep frees it. That is correct
// for the turf and bad for the volunteer: someone who meant to walk it on
// Sunday finds on Monday that it went back to the pool without a word, and the
// organizer sees an "expired" row that looks like flakiness rather than a
// missed reminder. A single DM some hours out — six by default, or what an admin
// sets — turns both of those into a choice: finish it, or hand it back so
// someone else can.
//
// Pure: no DB, no Slack, no clock of its own. The decision of WHO to warn and
// WHAT to say is all here and unit-tested; expiry-warning-store.ts does the
// rows and the sending.
//
// One warning per claim, ever. The sweep that sends these runs every half hour
// across the whole lead window, so the stamp on the row (not a timer, not a log
// line) is what keeps one reminder from becoming one per tick.

import { isActive, hoursRemaining, MAX_CLAIM_TTL_HOURS, type ClaimSnapshot } from './checkout.js';
import { campaignTimeLabel, campaignDayLabel } from '../campaign-time.js';

/**
 * How long before expiry to warn, unless an admin sets another lead time in
 * /settings (app_config.vanExpiryReminderHours).
 *
 * Six hours against a 48-hour default TTL: long enough to do something about
 * it — walk it that evening, or give it back before someone else's Saturday
 * planning depends on it — and short enough that the message still reads as
 * urgent rather than as filing.
 */
export const EXPIRY_WARNING_LEAD_HOURS = 6;

/** The lead time that means "send no reminder at all". It doubles as the
 *  floor, so a hand-edited row below it also reads as off. */
export const EXPIRY_REMINDER_OFF = 0;
export const MIN_EXPIRY_REMINDER_HOURS = EXPIRY_REMINDER_OFF;
/** As long as a claim may last (MAX_CLAIM_TTL_HOURS). A lead time is also
 *  held to the configured claim length (`reminderFitsClaim`). */
export const MAX_EXPIRY_REMINDER_HOURS = MAX_CLAIM_TTL_HOURS;

/**
 * Whether a lead time fits inside a claim of `claimTtlHours`: shorter than it.
 * One as long as the claim, or longer, warns at the first sweep after claiming,
 * which is no reminder at all, so the settings page refuses it. Off always fits.
 */
export function reminderFitsClaim(reminderHours: number, claimTtlHours: number): boolean {
	return reminderHours < claimTtlHours;
}

/**
 * The configured lead time, clamped. NULL or a non-number means the default.
 * Clamped rather than rejected, as resolveClaimOptions does: an out-of-range
 * value is a hand-edited row, and not worth failing a sync over.
 */
export function resolveExpiryReminderHours(value: number | null | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return EXPIRY_WARNING_LEAD_HOURS;
	return Math.min(MAX_EXPIRY_REMINDER_HOURS, Math.max(MIN_EXPIRY_REMINDER_HOURS, value));
}

/** A claim as this module needs to see it: the lifecycle stamps, plus whether
 *  it has already been warned. */
export type WarnableClaim = ClaimSnapshot & { expiryWarnedAt: string | null };

/**
 * Whether this claim is due its one expiry warning. Never, with the lead time
 * set to EXPIRY_REMINDER_OFF.
 *
 * Three conditions, and the order is the interesting part:
 *
 *   1. Not already warned. The stamp is the idempotency key.
 *   2. Still held — `isActive` covers released, completed, AND already lapsed,
 *      which is why it is reused rather than re-derived. Warning someone that
 *      turf they gave back is about to expire is worse than saying nothing.
 *   3. Inside the lead window.
 *
 * A claim whose whole TTL is shorter than the lead time qualifies immediately.
 * That is intended: "this expires in two hours" is true and useful, and the
 * alternative — staying silent because we could not warn early enough — loses
 * the volunteer the turf.
 */
export function needsExpiryWarning(
	claim: WarnableClaim,
	now: Date,
	leadHours: number = EXPIRY_WARNING_LEAD_HOURS,
): boolean {
	if (leadHours <= EXPIRY_REMINDER_OFF) return false;
	if (claim.expiryWarnedAt !== null) return false;
	if (!isActive(claim, now)) return false;
	return hoursRemaining(claim, now) <= leadHours;
}

export interface ExpiryWarningInput {
	turfName: string;
	regionName: string;
	doorCount: number;
	chapterId: number;
	expiresAt: string;
	hoursLeft: number;
	appUrl: string;
}

/**
 * The DM text, as Slack mrkdwn.
 *
 * Written as a choice rather than a scolding. The volunteer has not done
 * anything wrong — most people who let turf lapse simply ran out of weekend —
 * so the message leads with the fact, gives both next steps equal weight, and
 * closes by saying what happens if they do nothing. A reminder that reads as a
 * telling-off gets muted, and a muted reminder is worse than none.
 *
 * **The MiniVAN list number is deliberately absent.** The recipient is the
 * holder, so including it would be permissible — but they already have it from
 * the claim, `/turfs-mine` and the turf page, and nothing about it changed. The
 * one DM that does carry it is reconcile-store.ts's, when VAN replaced it and
 * the holder's copy stopped working. The link goes to the page that has it.
 */
export function renderExpiryWarning(input: ExpiryWarningInput): string {
	const { turfName, regionName, doorCount, chapterId, expiresAt, hoursLeft, appUrl } = input;

	const where = regionName ? ` — ${regionName}` : '';
	const when = `${campaignDayLabel(expiresAt)} at ${campaignTimeLabel(expiresAt)}`;
	const hours = hoursLeft === 1 ? '1 hour' : `${hoursLeft} hours`;
	const link = `${appUrl}/turfs?chapter=${chapterId}`;

	return [
		`:hourglass_flowing_sand: *Your turf expires in about ${hours}.*`,
		'',
		`*${turfName}*${where} · ${doorCount.toLocaleString('en-US')} doors`,
		`Yours until ${when}.`,
		'',
		"If you've walked it, mark it done. If you're not going to get to it, give it back so " +
			'someone else can take it.',
		`<${link}|Open turf checkout>`,
		'',
		"If you do nothing, it goes back to the pool when the time's up — no harm done, but " +
			'nobody will know it was free.',
	].join('\n');
}

/** Hours left on a claim, rounded up — what the DM quotes. Re-exported from
 *  checkout.ts so the warning and the turf page cannot round differently. */
export { hoursRemaining };

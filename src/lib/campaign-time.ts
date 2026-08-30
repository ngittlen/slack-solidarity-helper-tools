// Rendering timestamps in the campaign's own clock.
//
// Everything is stored as ISO-8601 UTC, which is right for storage and wrong
// for reading: a canvass that ran Saturday evening should say Saturday, not
// Sunday, and a knock at 9pm belongs to the day the volunteer was out.
//
// `America/Detroit` is the campaign's timezone, already the assumption in
// door-knock-leaderboard.ts and door-knock-projection.ts, which pin their day
// buckets to it. Those keep it private because they only bucket; this module
// exists because the activity history needs to *display* it.
//
// Formatting happens on the SERVER and ships as strings in the payload. Doing
// it in the browser would render each row in whatever zone the reader's laptop
// is set to — so two organizers comparing notes would see different times for
// the same event — and would risk an SSR/client hydration mismatch on every
// row. One clock, decided once.

export const CAMPAIGN_TIME_ZONE = 'America/Detroit';

/** `en-CA` gives ISO-ordered `YYYY-MM-DD`, which sorts and compares as a
 *  string. The same trick door-knock/openfield/provider.ts uses for its day
 *  keys. */
const DAY_KEY = new Intl.DateTimeFormat('en-CA', {
	timeZone: CAMPAIGN_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
	timeZone: CAMPAIGN_TIME_ZONE,
	weekday: 'long',
	month: 'short',
	day: 'numeric',
});

const TIME_LABEL = new Intl.DateTimeFormat('en-US', {
	timeZone: CAMPAIGN_TIME_ZONE,
	hour: 'numeric',
	minute: '2-digit',
});

function parse(iso: string): Date | null {
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Campaign-local calendar day, as `YYYY-MM-DD`.
 *
 * The grouping key for a day-by-day history. Derived here rather than from the
 * ISO string's own date, which would bucket anything after 8pm ET into
 * tomorrow — precisely the hours a canvass runs.
 */
export function campaignDayKey(iso: string): string {
	const date = parse(iso);
	return date ? DAY_KEY.format(date) : '';
}

/** Day heading, e.g. "Saturday, Aug 22". */
export function campaignDayLabel(iso: string): string {
	const date = parse(iso);
	return date ? DAY_LABEL.format(date) : 'Unknown date';
}

/** Time of day, e.g. "9:41 AM". */
export function campaignTimeLabel(iso: string): string {
	const date = parse(iso);
	return date ? TIME_LABEL.format(date) : '';
}

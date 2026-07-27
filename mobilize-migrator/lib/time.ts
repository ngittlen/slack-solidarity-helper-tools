// Solidarity returns absolute instants but renders them with an inconsistent
// UTC offset — the same session came back as both `...T18:00:00.000-06:00` and
// `...T20:00:00.000-04:00` across two calls. The instant is stable, the offset
// is not, so never read the wall time off the string: parse to an instant and
// re-render it in the campaign's timezone.
//
// Verified against the public event page for Solidarity event 27463, which
// displays "Thursday, July 30th at 8:00 pm" — matching the -04:00 rendering.
//
// Michigan is America/Detroit, but Mobilize validates `timezone` against a
// fixed choice list that rejects it ("not a valid choice"), so we use
// America/New_York — same offsets and DST rules, and what the dashboard itself
// sends for this campaign.

export const CAMPAIGN_TIMEZONE = 'America/New_York';

/**
 * Render an absolute instant as the naive local wall time Mobilize expects
 * ("2026-08-31T09:00"), paired with an explicit `timezone` field on the event.
 */
export function toNaiveLocal(iso: string, timeZone = CAMPAIGN_TIMEZONE): string {
	const instant = new Date(iso);
	if (Number.isNaN(instant.getTime())) throw new Error(`unparseable timestamp: ${iso}`);
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).formatToParts(instant);
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? '';
	// Intl renders midnight as hour "24" in some ICU versions; normalize.
	const hour = get('hour') === '24' ? '00' : get('hour');
	return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

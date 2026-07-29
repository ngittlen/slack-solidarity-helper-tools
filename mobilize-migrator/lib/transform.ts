// Turns Solidarity events into Mobilize event plans.
//
// Grouping rule (chosen deliberately): sessions are grouped by LOCATION only.
// Every future session at the same venue becomes one Mobilize event with one
// timeslot per session. A Solidarity event spanning five cities therefore
// produces five Mobilize events.

import { parseAddress } from './address.js';
import { parseCoordinates, type Coordinates } from './geocode.js';
import { htmlToMarkdown, plainTextToMarkdown } from './html-to-markdown.js';
import { EVENT_TYPE, type EventTypeName } from './payload.js';
import { type SolidarityEvent, type SolidaritySession } from './solidarity.js';

export interface PlannedEvent {
	/** Stable key for the ledger: one Solidarity event + one location. */
	key: string;
	solidarityEventId: number;
	solidaritySessionIds: number[];
	title: string;
	description: string;
	eventType: EventTypeName;
	locationName: string;
	addressLine1: string;
	city: string;
	state: string;
	zipcode: string;
	country: string;
	/** Street address is withheld from the payload when this is set. */
	locationIsPrivate: boolean;
	/** The venue's point, when Solidarity has one. Mobilize does not take
	 *  coordinates, but `postal_code` is required and often missing, and the sync
	 *  geocodes this to recover it — see lib/geocode.ts. */
	coordinates: Coordinates | null;
	/** Unix seconds, which is what the v1 API takes. */
	timeslots: { startDate: number; endDate: number; maxAttendees: number | null }[];
	/** Absolute instants in ms, kept for duplicate detection and timeslot matching. */
	startInstants: number[];
	endInstants: number[];
	sourceUrl: string | null;
	/** Solidarity-hosted image; must be re-uploaded before Mobilize will take it. */
	sourceImageUrl: string | null;
}

export interface SkippedEvent {
	solidarityEventId: number;
	title: string;
	reason: string;
}

/**
 * Solidarity has no structured "is this a canvass" flag, so classify off the
 * text. The campaign only wants COMMUNITY and COMMUNITY_CANVASS, and the dry
 * run prints the choice per event so it can be eyeballed before applying.
 */
const CANVASS_PATTERN = /\b(canvass|canvas|knock|door|lit\s*drop|turf)\b/i;

export function classifyEventType(title: string, description: string): EventTypeName {
	return CANVASS_PATTERN.test(`${title} ${description}`)
		? EVENT_TYPE.COMMUNITY_CANVASS
		: EVENT_TYPE.COMMUNITY;
}

/** Groups sessions that share a venue. Falls back to the venue name when there
 *  is no structured address, so two unaddressed venues don't merge. */
function locationKey(session: SolidaritySession): string {
	const address = session.location_data?.full_address ?? session.location_address ?? '';
	const name = session.location_name ?? '';
	return (address || name).trim().toLowerCase();
}

interface ResolvedLocation {
	location: NonNullable<SolidaritySession['location_data']> | Record<string, never>;
	addressLine1: string;
	city: string;
	state: string;
	zipcode: string;
	country: string;
	venueExtra: string;
	withAddress: SolidaritySession;
}

/**
 * Finds a usable street address for a group of sessions. Prefers Solidarity's
 * structured location_data, but most sessions leave those components blank and
 * only carry the Google-formatted `location_address` string, so fall back to
 * parsing that.
 *
 * City-only results (no street) are rejected: Mobilize would place a pin on the
 * city centroid, which is worse than a missing event a human can add correctly.
 */
function resolveLocation(sessions: SolidaritySession[]): ResolvedLocation | null {
	// Last-resort zip, used only where the session supplying the address has none
	// of its own: Solidarity often fills address_postal_code on a record whose
	// address_city is blank, and the all-or-nothing structured branch below would
	// otherwise discard a perfectly good zip, leaving the payload with the one
	// field Mobilize insists on empty. Borrowing across the group is sound because
	// they share a location key, but it stays the fallback rather than the answer.
	const harvestedZip =
		sessions.map((s) => (s.location_data?.address_postal_code ?? '').trim()).find(Boolean) ?? '';

	const structured = sessions.find(
		(s) => s.location_data?.address_line_1 && s.location_data.address_city,
	);
	if (structured) {
		const data = structured.location_data!;
		return {
			location: data,
			addressLine1: data.address_line_1!,
			city: data.address_city!,
			state: data.address_state || 'MI',
			zipcode: data.address_postal_code || harvestedZip,
			country: data.address_country || 'US',
			venueExtra: '',
			withAddress: structured,
		};
	}

	for (const session of sessions) {
		const parsed = parseAddress(session.location_address);
		if (parsed.quality !== 'full') continue;
		return {
			location: session.location_data ?? {},
			addressLine1: parsed.addressLine1,
			city: parsed.city,
			state: parsed.state || 'MI',
			zipcode: parsed.zipcode || harvestedZip,
			country: parsed.country,
			venueExtra: parsed.venueExtra,
			withAddress: session,
		};
	}
	return null;
}

/**
 * Mobilize requires a non-blank description, and a handful of Solidarity events
 * have none at all — no `description`, no ActionPage HTML, no session note. They
 * used to be rejected with 400 every night. The title plus the signup page is
 * the most useful thing that can honestly be said about them.
 */
export function fallbackDescription(title: string, pageUrl: string | null): string {
	const heading = `**${title.trim()}**`;
	return pageUrl ? `${heading}\n\nDetails and updates:\n${pageUrl}` : heading;
}

/** Solidarity uses 0 for "no cap"; Mobilize would read 0 as "nobody may sign up". */
function capacity(session: SolidaritySession): number | null {
	return session.max_capacity && session.max_capacity > 0 ? session.max_capacity : null;
}

export interface PlanResult {
	planned: PlannedEvent[];
	skipped: SkippedEvent[];
}

/**
 * Best available description, as Mobilize-flavored Markdown.
 *
 * Prefers the linked ActionPage's HTML (bold, links, lists intact) and falls
 * back to the events endpoint's flattened plain text, whose single newlines
 * would otherwise render as one run-on paragraph.
 */
export function buildDescription(
	event: SolidarityEvent,
	pageDescriptions?: Map<number, string>,
): string {
	const html = event.event_page_id ? pageDescriptions?.get(event.event_page_id) : undefined;
	if (html) {
		const markdown = htmlToMarkdown(html);
		if (markdown) return markdown;
	}
	return plainTextToMarkdown(event.description ?? '');
}

export function planMigration(
	events: SolidarityEvent[],
	now = Date.now(),
	pageDescriptions?: Map<number, string>,
): PlanResult {
	const planned: PlannedEvent[] = [];
	const skipped: SkippedEvent[] = [];

	for (const event of events) {
		if (event.event_type !== 'in_person') {
			// Virtual events need a join URL that the list payload doesn't expose.
			continue;
		}
		if (event.is_co_hosted_mirror) {
			// A mirror is another org's copy of the same real event.
			continue;
		}

		const future = event.event_sessions.filter((s) => Date.parse(s.start_time) > now);
		if (future.length === 0) continue;

		const groups = new Map<string, SolidaritySession[]>();
		for (const session of future) {
			const key = locationKey(session);
			const existing = groups.get(key);
			if (existing) existing.push(session);
			else groups.set(key, [session]);
		}

		for (const [key, sessions] of groups) {
			const resolved = resolveLocation(sessions);
			if (!resolved) {
				skipped.push({
					solidarityEventId: event.id,
					title: `${event.title}${key ? ` @ ${key}` : ''}`,
					reason: `no usable address on ${sessions.length} session(s) — likely virtual, TBD, or city-only`,
				});
				continue;
			}
			const { addressLine1, city, venueExtra, withAddress } = resolved;

			const sourceDescription = buildDescription(event, pageDescriptions);
			// A multi-location event would otherwise produce several identically
			// named Mobilize events; the session title usually already carries the
			// city ("Operation Get Out the Vote: Flint"), so prefer it.
			const sessionTitle = sessions.find((s) => s.title)?.title ?? '';
			const title =
				groups.size > 1 && sessionTitle && sessionTitle !== event.title
					? sessionTitle
					: groups.size > 1
						? `${event.title} — ${city}`
						: event.title;

			// Read from the session the address itself came from, so a geocoded zip
			// describes the address being published. Grouping only guarantees a shared
			// location KEY — the same address string, or the same venue name where no
			// session has an address at all — which is not quite the same as a shared
			// point: two venues can share a name, and one session in a group can carry
			// coordinates while another does not. Any other session in the group is a
			// fallback for exactly that second case.
			const coordinates =
				parseCoordinates(withAddress.location_data?.coordinates) ??
				sessions.map((s) => parseCoordinates(s.location_data?.coordinates)).find(Boolean) ??
				null;

			// postal_code is the one required field in the v1 location object, and
			// for a private event it is all that places the pin — there is no street
			// line to fall back on. The sync geocodes a missing one from the venue's
			// coordinates, so only an event with neither is beyond rescue.
			if (event.hide_address_until_rsvp && !resolved.zipcode && !coordinates) {
				skipped.push({
					solidarityEventId: event.id,
					title: `${event.title}${key ? ` @ ${key}` : ''}`,
					reason: 'address is hidden until RSVP but the session has no postal code',
				});
				continue;
			}

			const description =
				sourceDescription.trim() || fallbackDescription(title, event.event_page_url);
			const eventType = classifyEventType(`${title} ${event.title}`, description);
			const ordered = [...sessions].sort(
				(a, b) => Date.parse(a.start_time) - Date.parse(b.start_time),
			);

			planned.push({
				key: `solidarity:${event.id}:${key}`,
				solidarityEventId: event.id,
				solidaritySessionIds: ordered.map((s) => s.id),
				title: title.trim(),
				description,
				eventType,
				locationName: withAddress.location_name?.trim() || venueExtra || city,
				addressLine1,
				city,
				state: resolved.state,
				zipcode: resolved.zipcode,
				country: resolved.country,
				locationIsPrivate: event.hide_address_until_rsvp,
				coordinates,
				timeslots: ordered.map((s) => ({
					startDate: Math.floor(Date.parse(s.start_time) / 1000),
					endDate: Math.floor(Date.parse(s.end_time) / 1000),
					maxAttendees: capacity(s),
				})),
				startInstants: ordered.map((s) => Date.parse(s.start_time)),
				endInstants: ordered.map((s) => Date.parse(s.end_time)),
				sourceUrl: event.event_page_url,
				sourceImageUrl: event.image_url ?? null,
			});
		}
	}

	return { planned, skipped };
}

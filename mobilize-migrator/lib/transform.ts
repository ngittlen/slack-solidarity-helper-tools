// Turns Solidarity events into Mobilize event plans.
//
// Grouping rule (chosen deliberately): sessions are grouped by LOCATION only.
// Every future session at the same venue becomes one Mobilize event with one
// timeslot per session. A Solidarity event spanning five cities therefore
// produces five Mobilize events.

import { parseAddress } from './address.js';
import { htmlToMarkdown, plainTextToMarkdown } from './html-to-markdown.js';
import { EVENT_TYPE } from './payload.js';
import {
	parseCoordinates,
	type SolidarityEvent,
	type SolidaritySession,
} from './solidarity.js';
import { CAMPAIGN_TIMEZONE, toNaiveLocal } from './time.js';

export interface PlannedEvent {
	/** Stable key for the ledger: one Solidarity event + one location. */
	key: string;
	solidarityEventId: number;
	solidaritySessionIds: number[];
	title: string;
	description: string;
	eventType: number;
	eventTypeName: string;
	locationName: string;
	addressLine1: string;
	city: string;
	state: string;
	zipcode: string;
	country: string;
	lat: number | null;
	lon: number | null;
	locationIsPrivate: boolean;
	timeslots: { startsAtNaive: string; endsAtNaive: string; maxAttendees: number | null }[];
	/** Absolute instants, kept for duplicate detection and timeslot matching. */
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

export function classifyEventType(title: string, description: string): number {
	return CANVASS_PATTERN.test(`${title} ${description}`)
		? EVENT_TYPE.COMMUNITY_CANVASS
		: EVENT_TYPE.COMMUNITY;
}

export function eventTypeName(code: number): string {
	return code === EVENT_TYPE.COMMUNITY_CANVASS ? 'COMMUNITY_CANVASS' : 'COMMUNITY';
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
			zipcode: data.address_postal_code || '',
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
			zipcode: parsed.zipcode,
			country: parsed.country,
			venueExtra: parsed.venueExtra,
			withAddress: session,
		};
	}
	return null;
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

			const description = buildDescription(event, pageDescriptions);
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

			const eventType = classifyEventType(`${title} ${event.title}`, description);
			const coords = parseCoordinates(withAddress.location_data);
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
				eventTypeName: eventTypeName(eventType),
				locationName: withAddress.location_name?.trim() || venueExtra || city,
				addressLine1,
				city,
				state: resolved.state,
				zipcode: resolved.zipcode,
				country: resolved.country,
				lat: coords?.lat ?? null,
				lon: coords?.lon ?? null,
				locationIsPrivate: event.hide_address_until_rsvp,
				timeslots: ordered.map((s) => ({
					startsAtNaive: toNaiveLocal(s.start_time, CAMPAIGN_TIMEZONE),
					endsAtNaive: toNaiveLocal(s.end_time, CAMPAIGN_TIMEZONE),
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

// Canvass events for the /turfs map: Solidarity events carrying the admin's
// canvass tag, in the chapter on screen, over the week ahead.
//
// Every /turfs load in every chapter reads the same event list, and a full
// sweep of /v1/events is many paginated requests against a 60-per-30s rate
// limit. So the list comes from the shared Solidarity cache, and a page load
// never waits on it: a stale list is served while the next sweep runs, and a
// cold one shows no canvasses until the first sweep lands.

import {
	hasTag,
	parseCoordinates,
	type SolidarityEvent,
	type SolidaritySession,
} from '../../../mobilize-migrator/lib/solidarity.js';
import { campaignTimeLabel } from '$lib/campaign-time.js';
import type { CanvassEventCard, CanvassSession } from '$lib/canvass-events/types.js';
import { CARD_WINDOW_DAYS, milesBetween, walkDayLabel } from '$lib/mentor-walks/rules.js';
import { errMessage } from '$lib/err-message.js';
import { getSolidarityEventRecords } from './autocomplete-sources.js';
import { SOLIDARITY_API_TOKEN } from './env.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Keeps the payload bounded for a chapter running a canvass every few hours. */
export const MAX_CANVASS_CARDS = 10;
export const MAX_SESSIONS_PER_CARD = 12;

async function solidarityEvents(): Promise<SolidarityEvent[]> {
	const { items } = await getSolidarityEventRecords(SOLIDARITY_API_TOKEN, {
		staleWhileRevalidate: true,
	});
	return items;
}

function placeOf(session: SolidaritySession): string {
	const name = session.location_name?.trim() ?? '';
	const address =
		session.location_address?.trim() || session.location_data?.full_address?.trim() || '';
	if (name && address && !address.startsWith(name)) return `${name} · ${address}`;
	return address || name;
}

/** Sessions this close together are one spot on the map: a metre or so,
 *  so the same address geocoded twice still lands in one card. */
function spotKey(point: { lat: number; lon: number }): string {
	return `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
}

interface PlacedSession {
	key: string;
	start: number;
	session: CanvassSession;
	/** The session's title, or its event's: what the card is called when
	 *  it's the soonest at its place. */
	title: string;
	place: string;
	description: string;
	point: { lat: number; lng: number };
}

/**
 * Every tagged session in `chapterIds` that hasn't ended and starts within
 * the week, unsorted. One under way stays, as a walk does, for whoever is
 * free to join it late.
 * An event that hides its address until RSVP is left off entirely: a marker
 * would publish the address it hides. So is one with no Solidarity page,
 * which nobody could RSVP to. A session needs coordinates to be placed, so
 * one without them, or a virtual one, is left off too.
 */
function placedSessions(
	events: SolidarityEvent[],
	opts: { tag: string; chapterIds: ReadonlySet<number>; now: Date },
): PlacedSession[] {
	if (!opts.tag) return [];
	const now = opts.now.getTime();
	const until = now + CARD_WINDOW_DAYS * DAY_MS;
	const placed: PlacedSession[] = [];
	for (const event of events) {
		if (event.scope_type !== 'Chapter' || !opts.chapterIds.has(event.scope_id)) continue;
		if (!hasTag(event, opts.tag)) continue;
		if (event.hide_address_until_rsvp || event.is_co_hosted_mirror) continue;
		const rsvpUrl = event.event_page_url?.trim();
		if (!rsvpUrl) continue;
		for (const session of event.event_sessions ?? []) {
			const start = Date.parse(session.start_time);
			if (!(start <= until)) continue;
			const end = Date.parse(session.end_time);
			const endsAfterStart = Number.isFinite(end) && end > start;
			if (!((endsAfterStart ? end : start) > now)) continue;
			if (session.event_type === 'virtual') continue;
			const coordinates = parseCoordinates(session.location_data);
			if (!coordinates) continue;
			const place = placeOf(session);
			if (!place) continue;
			const startsAt = new Date(start).toISOString();
			const endsAt = endsAfterStart ? new Date(end).toISOString() : startsAt;
			const endLabel = endsAt === startsAt ? '' : ` – ${campaignTimeLabel(endsAt)}`;
			placed.push({
				key: spotKey(coordinates),
				start,
				title: session.title?.trim() || event.title.trim(),
				place,
				description: event.description?.trim() ?? '',
				point: { lat: coordinates.lat, lng: coordinates.lon },
				session: {
					id: `${event.id}-${session.id}`,
					dayLabel: walkDayLabel(startsAt, opts.now),
					timeLabel: `${campaignTimeLabel(startsAt)}${endLabel}`,
					startsAt,
					endsAt,
					title: null,
					rsvpUrl,
				},
			});
		}
	}
	return placed;
}

/** The cards for one chapter: one per place, soonest place first, each with
 *  its sessions soonest first. */
export function canvassCards(
	events: SolidarityEvent[],
	opts: { tag: string; chapterId: number; now: Date },
): CanvassEventCard[] {
	const placed = placedSessions(events, { ...opts, chapterIds: new Set([opts.chapterId]) });
	// Soonest first, so each place's first session is the one its card is
	// named and described by, and places come in the order they next meet.
	placed.sort((a, b) => a.start - b.start);
	const cards = new Map<string, CanvassEventCard>();
	for (const p of placed) {
		let card = cards.get(p.key);
		if (!card) {
			if (cards.size === MAX_CANVASS_CARDS) continue;
			card = {
				id: p.session.id,
				title: p.title,
				place: p.place,
				description: p.description,
				point: p.point,
				sessions: [],
			};
			cards.set(p.key, card);
		}
		if (card.sessions.length === MAX_SESSIONS_PER_CARD) continue;
		card.sessions.push({ ...p.session, title: p.title === card.title ? null : p.title });
	}
	return [...cards.values()];
}

/** How many canvass sessions this week meet within `radiusMiles` of `point`,
 *  in any of `chapterIds`: the signed-out teaser's count, which spans the
 *  chapters /turfs offers since a visitor has none yet. */
export function countCanvassesNear(
	events: SolidarityEvent[],
	opts: {
		tag: string;
		chapterIds: readonly number[];
		point: { lat: number; lng: number };
		radiusMiles: number;
		now: Date;
	},
): number {
	const placed = placedSessions(events, { ...opts, chapterIds: new Set(opts.chapterIds) });
	return placed.filter((p) => milesBetween(opts.point, p.point) <= opts.radiusMiles).length;
}

/** countCanvassesNear against the shared sweep. Never throws: the teaser's
 *  doors and canvassers don't depend on it. */
export async function loadCanvassCountNear(
	opts: Parameters<typeof countCanvassesNear>[1],
): Promise<number> {
	if (!opts.tag || !SOLIDARITY_API_TOKEN) return 0;
	try {
		return countCanvassesNear(await solidarityEvents(), opts);
	} catch (err) {
		console.error('[canvass-events] could not count nearby canvasses:', errMessage(err));
		return 0;
	}
}

/**
 * The chapter's canvass events for /turfs. Never throws: a Solidarity outage
 * costs the canvass markers, not the turf map.
 */
export async function loadCanvassEvents(ctx: {
	tag: string;
	chapterId: number;
	now: Date;
}): Promise<CanvassEventCard[]> {
	if (!ctx.tag || !SOLIDARITY_API_TOKEN) return [];
	try {
		return canvassCards(await solidarityEvents(), ctx);
	} catch (err) {
		console.error('[canvass-events] could not build the canvass cards:', errMessage(err));
		return [];
	}
}

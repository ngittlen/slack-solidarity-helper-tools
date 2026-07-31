// Read side: Solidarity's public v1 API. Only the pieces the migration needs.
//
// Note the shape mismatch that drives the whole transform: a Solidarity event
// owns many *sessions*, and each session carries its own location and time. A
// Mobilize event has ONE address plus many timeslots. So one Solidarity event
// can become several Mobilize events.

import { requireEnv } from './env.js';

export interface SolidarityLocationData {
	full_address?: string | null;
	address_line_1?: string | null;
	address_city?: string | null;
	address_state?: string | null;
	address_postal_code?: string | null;
	address_country?: string | null;
	/** JSON-encoded: {"lat":42.98,"lng":-83.67} */
	coordinates?: string | null;
}

export interface SolidaritySession {
	id: number;
	title: string | null;
	start_time: string;
	end_time: string;
	location_name: string | null;
	location_address: string | null;
	location_data: SolidarityLocationData | null;
	max_capacity: number | null;
	event_type: string;
}

export interface SolidarityEvent {
	id: number;
	title: string;
	event_type: string;
	scope_id: number;
	scope_type: string;
	/** Flattened plain text — the formatted original lives on the linked page. */
	description: string | null;
	event_page_id: number | null;
	event_page_url: string | null;
	/** Solidarity-hosted S3 image, public. Mobilize will not accept it directly. */
	image_url: string | null;
	hide_address_until_rsvp: boolean;
	is_co_hosted_mirror: boolean;
	primary_event_id: number;
	/** Free-text organizer tags — "wayne", "doorshift", "slack-exclude". */
	tags?: string[] | null;
	event_sessions: SolidaritySession[];
}

/** Tagging an event with this in Solidarity keeps it off mobilize.us. Mirrors
 *  `slack-exclude`, which keeps an event out of the Slack announcements. */
export const MOBILIZE_EXCLUDE_TAG = 'mobilize-exclude';

/** Tags are compared case- and space-insensitively: they are typed by hand, and
 *  Solidarity preserves whatever was typed ("Student", "volunteer event"). */
export function hasTag(event: Pick<SolidarityEvent, 'tags'>, tag: string): boolean {
	return (event.tags ?? []).some((t) => t.trim().toLowerCase() === tag);
}

const PAGE_LIMIT = 100;
// Events come back newest-first, so upcoming ones cluster at the start; this is
// a safety cap, not an expected depth.
const MAX_PAGES = 60;

/**
 * `apiToken` is passed explicitly by the server (which reads $env) and falls
 * back to the .env.local loader for the standalone CLI scripts — the same
 * dual-use pattern as src/lib/server/solidarity-paginate.ts.
 */
export async function fetchAllEvents(apiToken?: string): Promise<SolidarityEvent[]> {
	const token = apiToken || requireEnv('SOLIDARITY_API_TOKEN', 'set it in .env.local');
	const all: SolidarityEvent[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const url = `https://api.solidarity.tech/v1/events?_limit=${PAGE_LIMIT}&_offset=${page * PAGE_LIMIT}`;
		const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
		if (res.status === 429) {
			// Documented limit is 60 requests / 30s; back off and retry this page.
			await new Promise((r) => setTimeout(r, 5000));
			page--;
			continue;
		}
		if (!res.ok) {
			throw new Error(`Solidarity events returned ${res.status}: ${await res.text()}`);
		}
		const body = (await res.json()) as { data?: SolidarityEvent[] };
		const items = body.data ?? [];
		all.push(...items);
		if (items.length < PAGE_LIMIT) break;
	}
	return all;
}

export function parseCoordinates(
	data: SolidarityLocationData | null,
): { lat: number; lon: number } | null {
	if (!data?.coordinates) return null;
	try {
		const parsed = JSON.parse(data.coordinates) as { lat?: number; lng?: number };
		if (typeof parsed.lat !== 'number' || typeof parsed.lng !== 'number') return null;
		return { lat: parsed.lat, lon: parsed.lng };
	} catch {
		return null;
	}
}

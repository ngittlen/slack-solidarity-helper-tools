// Client for Mobilize's private dashboard API — the same endpoint the event
// create form posts to. There is no public write API, so this is the only way
// to create events programmatically.
//
// Read-back goes through the PUBLIC api.mobilize.us instead: the dashboard API
// answers 405 to GET, so the public feed is our only view of what exists.

import { loadSession, type MobilizeSession } from './session.js';

const PRIVATE_BASE = 'https://www.mobilize.us/_/api/organization';
const PUBLIC_BASE = 'https://api.mobilize.us/v1';

export interface MobilizeErrorBody {
	error?: { detail?: string; message?: string } | null;
	data?: unknown;
}

export class MobilizeError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: string,
	) {
		super(message);
		this.name = 'MobilizeError';
	}
}

function dashboardHeaders(session: MobilizeSession, referer: string): Record<string, string> {
	return {
		Accept: 'application/json',
		'Content-Type': 'application/json',
		'X-CSRFToken': session.csrfToken,
		Cookie: session.cookie,
		Referer: referer,
		Origin: 'https://www.mobilize.us',
		'User-Agent': session.userAgent,
	};
}

/**
 * POST a fully-formed event payload. Returns the created event's id.
 *
 * A 403 here almost always means the borrowed session expired — see
 * lib/session.ts for how to refresh it.
 */
export async function createEvent(
	payload: Record<string, unknown>,
	session = loadSession(),
): Promise<{ id: number; raw: unknown }> {
	const res = await fetch(`${PRIVATE_BASE}/${session.orgSlug}/events/`, {
		method: 'POST',
		headers: dashboardHeaders(
			session,
			`https://www.mobilize.us/dashboard/${session.orgSlug}/event/create/`,
		),
		body: JSON.stringify(payload),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new MobilizeError(
			`create returned ${res.status}${res.status === 403 ? ' (session likely expired)' : ''}`,
			res.status,
			text,
		);
	}
	// The endpoint answers {"data":{"event_id":123}}; accept `id` too in case
	// that shape ever changes back.
	const body = JSON.parse(text) as { data?: { event_id?: number; id?: number } };
	const id = body.data?.event_id ?? body.data?.id;
	if (typeof id !== 'number') {
		throw new MobilizeError('create succeeded but no event id in response', res.status, text);
	}
	return { id, raw: body.data };
}

/**
 * Stamp existing timeslot ids onto a payload's slots, positionally.
 *
 * Only safe when the caller knows the two lists line up — for anything
 * non-trivial (shifts added, removed or moved) use reconcileTimeslots in
 * sync.ts, which matches by start time and preserves orphans.
 */
export function withTimeslotIds(
	payload: Record<string, unknown>,
	timeslotIds: number[],
): Record<string, unknown> {
	const timeslots = (payload.timeslots as Record<string, unknown>[]).map((slot, index) => {
		const timeslotId = timeslotIds[index];
		return timeslotId ? { ...slot, id: timeslotId } : slot;
	});
	return { ...payload, timeslots };
}

/**
 * Update an existing event. PUT replaces the whole record, and its timeslots are
 * matched by id — a slot sent WITHOUT an id is created, and one that is simply
 * absent is destroyed along with its signups. PATCH answers 200 {"ok":true} but
 * does not persist, so PUT is the only real update path.
 *
 * The caller owns timeslot identity: every slot in `payload.timeslots` that
 * should update an existing shift must already carry its `id` (see
 * `withTimeslotIds` or `reconcileTimeslots`). This used to take a separate
 * `timeslotIds` array, which meant two different calling conventions for the
 * same function and one silent way to duplicate every shift on an event.
 */
export async function updateEvent(
	id: number,
	payload: Record<string, unknown>,
	session = loadSession(),
): Promise<void> {
	const res = await fetch(`${PRIVATE_BASE}/${session.orgSlug}/events/${id}/`, {
		method: 'PUT',
		headers: dashboardHeaders(
			session,
			`https://www.mobilize.us/dashboard/${session.orgSlug}/event/${id}/edit/`,
		),
		body: JSON.stringify(payload),
	});
	if (!res.ok) {
		throw new MobilizeError(
			`update ${id} returned ${res.status}${res.status === 403 ? ' (session likely expired)' : ''}`,
			res.status,
			await res.text(),
		);
	}
}

/** Delete an event by id. Used to clean up the type-probe throwaways. */
export async function deleteEvent(id: number, session = loadSession()): Promise<void> {
	const res = await fetch(`${PRIVATE_BASE}/${session.orgSlug}/events/${id}/`, {
		method: 'DELETE',
		headers: dashboardHeaders(
			session,
			`https://www.mobilize.us/dashboard/${session.orgSlug}/event/${id}/edit/`,
		),
	});
	if (!res.ok && res.status !== 404) {
		throw new MobilizeError(`delete ${id} returned ${res.status}`, res.status, await res.text());
	}
}

export interface PublicEvent {
	id: number;
	title: string;
	event_type: string;
	browser_url?: string;
	visibility?: string;
	// Present on the list endpoint too, which is what lets the sync diff every
	// event from one bulk read instead of a fetch per event.
	description?: string;
	featured_image_url?: string | null;
	timeslots: { id: number; start_date: number; end_date: number }[];
	location: {
		venue?: string | null;
		locality?: string | null;
		region?: string | null;
		address_lines?: string[] | null;
	} | null;
}

/** Public read API. Rate limits aggressively, so retry on 429. */
async function publicGet(url: string): Promise<Response> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const res = await fetch(url, { headers: { 'User-Agent': 'solidarity-migrator' } });
		if (res.status !== 429) return res;
		await new Promise((r) => setTimeout(r, 15_000));
	}
	throw new Error(`public API still rate-limited: ${url}`);
}

/** Every upcoming public event for the org — the duplicate-detection corpus. */
export async function listUpcomingPublicEvents(orgId: number): Promise<PublicEvent[]> {
	const all: PublicEvent[] = [];
	let url: string | null =
		`${PUBLIC_BASE}/organizations/${orgId}/events?per_page=100&timeslot_start=gte_now`;
	while (url) {
		const res: Response = await publicGet(url);
		if (!res.ok) throw new Error(`public events returned ${res.status}: ${await res.text()}`);
		const body = (await res.json()) as { data?: PublicEvent[]; next?: string | null };
		all.push(...(body.data ?? []));
		url = body.next ?? null;
	}
	return all;
}

/** Read one event from the public API (used to confirm what a numeric code means). */
export async function getPublicEvent(id: number): Promise<PublicEvent | null> {
	const res = await publicGet(`${PUBLIC_BASE}/events/${id}`);
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`public event ${id} returned ${res.status}`);
	const body = (await res.json()) as { data?: PublicEvent };
	return body.data ?? null;
}

// Creating events, sessions and event pages in Solidarity — the write half the
// partner-org import (import.ts) needs. Everything else in this directory only
// reads Solidarity events.
//
// Path naming trap, same as rsvp.ts: multi-word resources use UNDERSCORES
// (/v1/event_sessions) even though the documentation URLs use hyphens.
//
// Solidarity's API cannot edit or delete an event once created — only its
// sessions — and the page endpoint only creates. So a wrong write here is
// fixed by hand in the dashboard, which is why the import is create-only and
// records each create the moment it succeeds.

import { fetchWithRetry } from '../../src/lib/server/solidarity-paginate.js';

const API = 'https://api.solidarity.tech/v1';
const LOG_TAG = 'mobilize-import';

export interface NewSolidarityEvent {
	title: string;
	event_type: 'in_person' | 'virtual';
	/** Unix seconds — the event's FIRST session. */
	start_time: number;
	end_time: number;
	scope_id: number;
	scope_type: 'Chapter' | 'Organization';
	location_name?: string | null;
	location_address?: string | null;
	virtual_url?: string | null;
	latitude?: number | null;
	longitude?: number | null;
	tags?: string[];
	allow_long_title?: boolean;
}

export interface NewSolidaritySession {
	event_id: number;
	title: string;
	start_time: number;
	end_time: number;
	event_type: 'in_person' | 'virtual';
	location_name?: string | null;
	location_address?: string | null;
	allow_long_title?: boolean;
}

export interface NewEventPage {
	/** HTML; Solidarity strips scripts and handlers. Max 100,000 chars. */
	content: string;
	/** Must be https. */
	image_url?: string | null;
}

/**
 * A Solidarity write that was refused. `status` is kept so callers can tell a
 * duplicate (409) or a bad payload (422) from an auth failure (401/403).
 */
export class SolidarityWriteError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: string,
	) {
		super(message);
		this.name = 'SolidarityWriteError';
	}
}

/**
 * Solidarity answered 2xx to an event create but gave back nothing we could
 * read an id from. The event almost certainly EXISTS — so this must not be
 * treated like an ordinary failure and retried, which would create it again.
 */
export class SolidarityCreateUnconfirmed extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'SolidarityCreateUnconfirmed';
	}
}

async function post(
	token: string,
	path: string,
	label: string,
	payload: unknown,
): Promise<Response> {
	return fetchWithRetry(
		`${API}${path}`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		},
		label,
		LOG_TAG,
		{ retriesUsed: 0 },
	);
}

async function fail(res: Response, label: string): Promise<never> {
	const body = (await res.text()).slice(0, 500);
	throw new SolidarityWriteError(
		`Solidarity ${label} returned ${res.status}: ${body.slice(0, 200)}`,
		res.status,
		body,
	);
}

/**
 * Solidarity wraps single resources as `{data: {...}}`, but the event-create
 * response shape is undocumented, so a bare object is accepted too rather than
 * failing a create that did happen.
 */
function unwrap(body: unknown): Record<string, unknown> {
	const obj = (body ?? {}) as Record<string, unknown>;
	const data = obj.data;
	return data && typeof data === 'object' ? (data as Record<string, unknown>) : obj;
}

export interface CreatedEvent {
	id: number;
	/** The first session's id, when the response carries it. */
	firstSessionId: number | null;
}

/** Create an event together with its first session. */
export async function createEvent(
	token: string,
	payload: NewSolidarityEvent,
): Promise<CreatedEvent> {
	const res = await post(token, '/events', 'event create', payload);
	if (!res.ok) return fail(res, 'event create');
	const event = unwrap(await res.json().catch(() => null));
	if (typeof event.id !== 'number') {
		throw new SolidarityCreateUnconfirmed(
			`Solidarity answered ${res.status} to the event create but returned no event id`,
			res.status,
		);
	}
	const sessions = (event.event_sessions ?? []) as { id?: unknown }[];
	const first = sessions[0]?.id;
	return { id: event.id, firstSessionId: typeof first === 'number' ? first : null };
}

/**
 * Add a session to an existing event. Returns the new session's id, or null
 * when Solidarity accepted the create but its answer carried no id.
 *
 * Null rather than a throw, unlike an unreadable EVENT create: a 2xx means the
 * session exists, and the caller records the timeslot as done either way. A
 * throw here would leave it unrecorded, and every later run would create the
 * same shift again — a fresh duplicate each hour.
 */
export async function createEventSession(
	token: string,
	payload: NewSolidaritySession,
): Promise<number | null> {
	const res = await post(token, '/event_sessions', 'session create', payload);
	if (!res.ok) return fail(res, 'session create');
	const session = unwrap(await res.json().catch(() => null));
	return typeof session.id === 'number' ? session.id : null;
}

export interface CreatedPage {
	pageId: number | null;
	pageUrl: string | null;
	/** True when the event already had a page (409) — nothing was changed. */
	alreadyExisted: boolean;
}

/**
 * Create the event's page. A 409 means it already has one, which for a resumed
 * import is success: an earlier run made the page and died before recording it.
 */
export async function createEventPage(
	token: string,
	eventId: number,
	payload: NewEventPage,
): Promise<CreatedPage> {
	const res = await post(token, `/events/${eventId}/page`, 'page create', payload);
	if (res.status !== 409 && !res.ok) return fail(res, 'page create');
	const event = unwrap(await res.json().catch(() => null));
	return {
		pageId: typeof event.event_page_id === 'number' ? event.event_page_id : null,
		pageUrl: typeof event.event_page_url === 'string' ? event.event_page_url : null,
		alreadyExisted: res.status === 409,
	};
}

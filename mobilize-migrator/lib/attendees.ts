// Reads event signups out of the Mobilize dashboard.
//
// The campaign has no Mobilize API key, so the documented
// `/v1/organizations/{id}/attendances` endpoint is unavailable and we use the
// dashboard's own per-timeslot data route with the borrowed session:
//
//   GET /dashboard/<org>/timeslot/<timeslot_id>/?page=N
//   Accept: application/json
//
// It answers with the whole SPA page payload; `data.participations` is the part
// we want, alongside `data.paging_info` (25 per page).

import { MobilizeError } from './mobilize.js';
import { loadSession, type MobilizeSession } from './session.js';

/**
 * Numeric signup status. Decoded by cross-checking a real timeslot against its
 * own `participant_count` summary: 81 signups split 77 registered / 4 cancelled,
 * and the 81 rows split exactly 77 with status 1 and 4 with status 2.
 *
 * CONFIRMED has its own count in the summary but was 0 everywhere observed, so
 * its numeric value is still unknown — anything unrecognized is reported rather
 * than guessed, because mapping it wrong would mark real attendees cancelled.
 */
export const PARTICIPATION_STATUS = {
	REGISTERED: 1,
	CANCELLED: 2,
} as const;

export type ParticipationStatus = 'REGISTERED' | 'CANCELLED' | 'UNKNOWN';

export interface MobilizeParticipation {
	/** participation_data.id — stable key for the sync ledger. */
	id: number;
	timeslotId: number;
	status: ParticipationStatus;
	rawStatus: number;
	/** null when Mobilize hasn't recorded an attendance outcome yet. */
	attended: boolean | null;
	firstName: string | null;
	lastName: string | null;
	email: string | null;
	phone: string | null;
	zipcode: string | null;
	createdAt: string | null;
}

interface RawParticipation {
	person?: Record<string, unknown> | null;
	participation_data?: Record<string, unknown> | null;
}

interface TimeslotPayload {
	participations?: RawParticipation[];
	paging_info?: { page: number | string; per_page: number; num_pages: number; count: number };
	too_many_participations?: boolean;
	timeslot?: { id: number; starts_at_utc?: string; ends_at_utc?: string } | null;
}

function toStatus(raw: unknown): ParticipationStatus {
	if (raw === PARTICIPATION_STATUS.REGISTERED) return 'REGISTERED';
	if (raw === PARTICIPATION_STATUS.CANCELLED) return 'CANCELLED';
	return 'UNKNOWN';
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeParticipation(row: RawParticipation): MobilizeParticipation | null {
	const data = row.participation_data ?? {};
	const person = row.person ?? {};
	const id = typeof data.id === 'number' ? data.id : null;
	const timeslotId = typeof data.timeslot_id === 'number' ? data.timeslot_id : null;
	if (id === null || timeslotId === null) return null;

	// The row carries the person's details twice; prefer the participation copy
	// (what they entered signing up), fall back to the linked person record.
	const pick = (key: string) => str(data[key]) ?? str(person[key]);

	return {
		id,
		timeslotId,
		status: toStatus(data.status),
		rawStatus: typeof data.status === 'number' ? data.status : -1,
		// Mobilize records a check-in time when someone actually turns up. No
		// check-in just means "not recorded", not "did not attend".
		attended: data.volunteer_check_in ? true : null,
		firstName: pick('first_name'),
		lastName: pick('last_name'),
		email: pick('email'),
		phone: pick('phone'),
		zipcode: pick('zipcode'),
		createdAt: str(data.created_at),
	};
}

export interface TimeslotParticipations {
	participations: MobilizeParticipation[];
	/**
	 * Mobilize sets `too_many_participations` when it refuses to enumerate a
	 * very large signup list. Surfaced rather than swallowed: ignoring it means
	 * quietly dropping attendees from the busiest events, which is precisely
	 * where an accurate list matters most.
	 */
	truncated: boolean;
}

/** Every signup on one timeslot, following pagination. */
export async function fetchTimeslotParticipations(
	timeslotId: number,
	session: MobilizeSession = loadSession(),
): Promise<TimeslotParticipations> {
	const all: MobilizeParticipation[] = [];
	let page = 1;
	let numPages: number;
	let truncated = false;

	do {
		const url = `https://www.mobilize.us/dashboard/${session.orgSlug}/timeslot/${timeslotId}/?page=${page}`;
		const res = await fetch(url, {
			headers: {
				Accept: 'application/json',
				'X-CSRFToken': session.csrfToken,
				Cookie: session.cookie,
				Referer: url,
				'User-Agent': session.userAgent,
			},
		});
		if (!res.ok) {
			throw new MobilizeError(
				`timeslot ${timeslotId} page ${page} returned ${res.status}` +
					(res.status === 403 ? ' (session likely expired)' : ''),
				res.status,
				(await res.text()).slice(0, 300),
			);
		}
		const body = (await res.json()) as { data?: TimeslotPayload };
		const data = body.data ?? {};
		for (const row of data.participations ?? []) {
			const normalized = normalizeParticipation(row);
			if (normalized) all.push(normalized);
		}
		if (data.too_many_participations) truncated = true;
		numPages = data.paging_info?.num_pages ?? 1;
		page++;
	} while (page <= numPages);

	return { participations: all, truncated };
}

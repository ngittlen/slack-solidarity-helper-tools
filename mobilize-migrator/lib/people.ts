// Finding — or creating — the Solidarity user behind a Mobilize signup.
//
// This is the riskiest part of the attendee sync. A missed match silently
// creates a duplicate person in the CRM; a wrong match files someone else's
// RSVP against a real member. Both fail quietly, so the matching rules here are
// deliberately narrow and the caller reports created-vs-matched counts.

// Reuses the retry/rate-limit handling from the app, which is deliberately free
// of $env imports so non-SvelteKit entry points can share it.
import { fetchWithRetry } from '../../src/lib/server/solidarity-paginate.js';

const API = 'https://api.solidarity.tech/v1';

export interface SolidarityPerson {
	id: number;
	email: string | null;
	phone_number: string | null;
	chapter_ids?: number[];
}

export interface PersonInput {
	firstName: string | null;
	lastName: string | null;
	email: string | null;
	phone: string | null;
	zipcode: string | null;
	/** From Mobilize's sms_opt_in_status, when known. */
	smsOptIn?: boolean | null;
}

export type MatchMethod = 'email' | 'phone' | 'created' | 'skipped';

export interface ResolvedPerson {
	userId: number;
	method: MatchMethod;
}

/**
 * A structurally valid NANP number: `1` + area code + exchange + line number,
 * where area code and exchange both start 2-9 and neither is an N11 service
 * code (411, 911...).
 *
 * Mobilize does no such check, so filler like 1234567890 or 0000000000 arrives
 * looking like a phone number. Solidarity rejects those at create time with a
 * 422 on `phone_number`, which used to surface as a nightly sync failure for
 * the same person forever.
 */
const NANP = /^1(?![2-9]11)[2-9]\d\d(?![2-9]11)[2-9]\d{6}$/;

/**
 * Normalize to the digits-only E.164 form Solidarity stores ("16165551234").
 * Mobilize hands us bare 10-digit national numbers.
 *
 * Solidarity's own matching is lenient — national, digits-only and +E.164 all
 * resolved to the same record in testing — so this only has to be consistent,
 * not exact.
 *
 * Structural validity is checked, but that is all it can prove: whether a
 * well-formed number actually reaches a phone that can receive texts is
 * Solidarity's call, and only it can answer that. See createUser.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const digits = raw.replace(/\D/g, '');
	const e164 = digits.length === 10 ? `1${digits}` : digits;
	// Anything else (short codes, non-US, junk) is not safely matchable.
	return NANP.test(e164) ? e164 : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
	const trimmed = raw?.trim().toLowerCase();
	return trimmed && trimmed.includes('@') ? trimmed : null;
}

async function search(
	token: string,
	query: string,
	label: string,
): Promise<SolidarityPerson | null> {
	const res = await fetchWithRetry(
		`${API}/users?_limit=2&${query}`,
		{ headers: { Authorization: `Bearer ${token}` } },
		label,
		'attendee-sync',
		{ retriesUsed: 0 },
	);
	if (!res.ok) throw new Error(`Solidarity user lookup returned ${res.status}`);
	const body = (await res.json()) as { data?: SolidarityPerson[] };
	const rows = body.data ?? [];
	// More than one hit means the identifier isn't unique in the CRM; refusing to
	// choose is safer than filing an RSVP against the wrong person.
	return rows.length === 1 ? rows[0]! : null;
}

/**
 * Look up by email, then phone.
 *
 * DANGER: the query parameter is `phone_number`. Solidarity accepts `phone=`
 * and *silently ignores it*, returning an unfiltered user list — matching on
 * that would attach signups to arbitrary strangers. Verified against the live
 * API: `?phone=15550000000` returned rows, `?phone_number=15550000000` returned
 * none. Do not "simplify" this parameter name.
 */
export async function findExistingUser(
	token: string,
	input: PersonInput,
): Promise<{ user: SolidarityPerson; method: 'email' | 'phone' } | null> {
	const email = normalizeEmail(input.email);
	if (email) {
		const byEmail = await search(
			token,
			`email=${encodeURIComponent(email)}`,
			'attendee email lookup',
		);
		if (byEmail) return { user: byEmail, method: 'email' };
	}

	const phone = normalizePhone(input.phone);
	if (phone) {
		const byPhone = await search(
			token,
			`phone_number=${encodeURIComponent(phone)}`,
			'attendee phone lookup',
		);
		if (byPhone) return { user: byPhone, method: 'phone' };
	}

	return null;
}

export interface CreateUserResult {
	id: number;
}

/**
 * Solidarity refused to create the profile.
 *
 * Carries the rejected field names so callers can tell a fixable rejection from
 * a real fault. The message keeps the body excerpt the old plain Error had —
 * Solidarity's validation replies name the field and the rule, never the value,
 * so it is safe for Slack.
 */
export class SolidarityUserCreateError extends Error {
	constructor(
		readonly status: number,
		readonly fields: string[],
		body: string,
	) {
		super(`Solidarity user create returned ${status}: ${body.slice(0, 200)}`);
		this.name = 'SolidarityUserCreateError';
	}

	/**
	 * Solidarity rejected the phone number itself. It verifies that a new
	 * profile's number can receive texts; Mobilize collects numbers without
	 * checking, so landlines, VoIP lines and typos all arrive here.
	 */
	get phoneRejected(): boolean {
		return this.status === 422 && this.fields.includes('phone_number');
	}
}

/** Field names from Solidarity's `details` array, when it sent one. */
function rejectedFields(body: string): string[] {
	try {
		const parsed = JSON.parse(body) as { details?: { field_name?: string }[] };
		return (parsed.details ?? []).map((d) => d.field_name).filter((f): f is string => !!f);
	} catch {
		return [];
	}
}

/**
 * Create a Solidarity profile for someone who signed up on Mobilize.
 *
 * Consent: only `sms_permission` is set, mirroring Mobilize's opt-in. Call and
 * email permission are left alone — signing up for an event is not consent to
 * be called, and asserting it on someone's behalf is exactly the kind of thing
 * that turns into a TCPA problem.
 */
export async function createUser(
	token: string,
	input: PersonInput,
	chapterId: number,
): Promise<CreateUserResult> {
	const email = normalizeEmail(input.email);
	const phone = normalizePhone(input.phone);
	if (!email && !phone) {
		throw new Error('cannot create a Solidarity user without an email or a phone number');
	}

	const body: Record<string, unknown> = {
		first_name: input.firstName,
		last_name: input.lastName,
		email,
		phone_number: phone,
		chapter_id: chapterId,
		// Provenance, so these are findable later if the matching needs auditing.
		custom_user_properties: { source_system: 'mobilize' },
		add_tags: ['mobilize-signup'],
	};
	if (typeof input.smsOptIn === 'boolean') body.sms_permission = input.smsOptIn;
	if (input.zipcode) body.address = { zip_code: input.zipcode };

	const res = await fetchWithRetry(
		`${API}/users`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		},
		'attendee user create',
		'attendee-sync',
		{ retriesUsed: 0 },
	);
	if (!res.ok) {
		const body = await res.text();
		throw new SolidarityUserCreateError(res.status, rejectedFields(body), body);
	}
	// `/v1/users` breaks the envelope convention the rest of the API follows: a
	// single user comes back BARE, while `/v1/event_rsvps/:id` and every list
	// endpoint wrap in `data`. Reading only `data.id` here threw "returned no id"
	// on profiles Solidarity had in fact created, so the person existed but their
	// RSVP never got filed. Both shapes are accepted rather than betting on one.
	const created = (await res.json()) as { id?: number; data?: { id?: number } };
	const id = typeof created.id === 'number' ? created.id : created.data?.id;
	if (typeof id !== 'number') {
		// Keys only — this response carries the person's email and phone, and this
		// message reaches Slack.
		throw new Error(
			`Solidarity user create returned no id (response keys: ${Object.keys(created).join(', ') || 'none'})`,
		);
	}
	return { id };
}

/** zip -> chapter, with the fallbacks the caller supplies. */
export interface ChapterResolver {
	/** Most common chapter among existing members in that zip. */
	byZip(zipcode: string | null): number | null;
	/** The chapter that owns the event, when it is chapter-scoped. */
	eventChapterId: number | null;
	/** Last resort so a profile can always be created. */
	defaultChapterId: number | null;
}

export function resolveChapterId(resolver: ChapterResolver, zipcode: string | null): number | null {
	return resolver.byZip(zipcode) ?? resolver.eventChapterId ?? resolver.defaultChapterId ?? null;
}

/**
 * Build the zip -> chapter table from where existing members actually sit.
 * Solidarity chapters carry no geographic data, so this is derived rather than
 * fetched. Ties break toward the chapter with more members in that zip.
 */
export function buildZipChapterMap(
	users: { address?: { zip_code?: string | null } | null; chapter_ids?: number[] | null }[],
): Map<string, { chapterId: number; memberCount: number }> {
	const counts = new Map<string, Map<number, number>>();
	for (const user of users) {
		const zip = user.address?.zip_code?.trim();
		if (!zip) continue;
		for (const chapterId of user.chapter_ids ?? []) {
			const perZip = counts.get(zip) ?? new Map<number, number>();
			perZip.set(chapterId, (perZip.get(chapterId) ?? 0) + 1);
			counts.set(zip, perZip);
		}
	}

	const winners = new Map<string, { chapterId: number; memberCount: number }>();
	for (const [zip, perZip] of counts) {
		let best: { chapterId: number; memberCount: number } | null = null;
		for (const [chapterId, memberCount] of perZip) {
			if (
				!best ||
				memberCount > best.memberCount ||
				(memberCount === best.memberCount && chapterId < best.chapterId)
			) {
				best = { chapterId, memberCount };
			}
		}
		if (best) winners.set(zip, best);
	}
	return winners;
}

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
 * Normalize to the digits-only E.164 form Solidarity stores ("16165551234").
 * Mobilize hands us bare 10-digit national numbers.
 *
 * Solidarity's own matching is lenient — national, digits-only and +E.164 all
 * resolved to the same record in testing — so this only has to be consistent,
 * not exact.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const digits = raw.replace(/\D/g, '');
	if (digits.length === 10) return `1${digits}`;
	if (digits.length === 11 && digits.startsWith('1')) return digits;
	// Anything else (short codes, non-US) is not safely matchable.
	return null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
	const trimmed = raw?.trim().toLowerCase();
	return trimmed && trimmed.includes('@') ? trimmed : null;
}

async function search(token: string, query: string, label: string): Promise<SolidarityPerson | null> {
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
		const byEmail = await search(token, `email=${encodeURIComponent(email)}`, 'attendee email lookup');
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
		throw new Error(`Solidarity user create returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	const created = (await res.json()) as { data?: { id?: number } };
	const id = created.data?.id;
	if (typeof id !== 'number') throw new Error('Solidarity user create returned no id');
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
	return (
		resolver.byZip(zipcode) ?? resolver.eventChapterId ?? resolver.defaultChapterId ?? null
	);
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
			if (!best || memberCount > best.memberCount || (memberCount === best.memberCount && chapterId < best.chapterId)) {
				best = { chapterId, memberCount };
			}
		}
		if (best) winners.set(zip, best);
	}
	return winners;
}

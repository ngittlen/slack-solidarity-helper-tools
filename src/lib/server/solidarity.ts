import { errMessage } from '../err-message.js';
import { SOLIDARITY_API_TOKEN } from './env.js';
import { fetchPaginated, fetchWithRetry } from './solidarity-paginate.js';

export interface SolidarityUser {
	id: number;
	chapter_id: number | null;
	chapter_ids: number[];
	address: {
		city: string | null;
		state: string | null;
	} | null;
}

/**
 * Look up a Solidarity user by email. THROWS on network/HTTP failures instead
 * of returning null — null strictly means "no account with this email". The
 * reconciliation diff depends on that distinction (a swallowed 500 must not
 * misclassify someone as account-less); lenient callers wrap it, see
 * getUserByEmail.
 */
export async function findUserByEmailStrict(
	token: string,
	email: string,
): Promise<SolidarityUser | null> {
	const url = `https://api.solidarity.tech/v1/users?email=${encodeURIComponent(email)}&_limit=1`;
	const response = await fetchWithRetry(
		url,
		{ headers: { Authorization: `Bearer ${token}` } },
		`user lookup for ${email}`,
		'solidarity',
		{ retriesUsed: 0 },
	);
	if (!response.ok) {
		throw new Error(`Solidarity user lookup returned ${response.status} for ${email}`);
	}
	const data = (await response.json()) as { data?: SolidarityUser[] };
	return data.data?.[0] ?? null;
}

/**
 * Lenient wrapper for flows where a failed lookup should degrade to "treat as
 * no account" rather than abort (the team_join welcome flow). Logs and
 * returns null on any failure.
 */
export async function getUserByEmail(email: string): Promise<SolidarityUser | null> {
	try {
		return await findUserByEmailStrict(SOLIDARITY_API_TOKEN, email);
	} catch (err) {
		console.error(`[solidarity] user lookup failed for ${email}:`, errMessage(err));
		return null;
	}
}

// ---------------------------------------------------------------------------
// Coalition reconciliation support
// ---------------------------------------------------------------------------

export interface SolidarityListUser {
	id: number;
	email: string | null;
	first_name?: string | null;
	last_name?: string | null;
}

/** Every member of a Solidarity user list (the per-coalition dynamic list). */
export function getUsersInList(token: string, listId: number): Promise<SolidarityListUser[]> {
	return fetchPaginated<SolidarityListUser>(
		token,
		'/v1/users',
		`/v1/users?user_list_ids=${listId}`,
		`&user_list_ids=${listId}`,
		'reconcile',
	);
}

/**
 * Mark a user as in a coalition: set the coalition's custom property.
 * `append_custom_user_properties: true` merges with whatever is already on the
 * user, so other properties (and other coalitions) are never clobbered.
 */
export async function setUserCustomProperty(
	token: string,
	userId: number,
	internalName: string,
	value: string,
): Promise<void> {
	const response = await fetchWithRetry(
		`https://api.solidarity.tech/v1/users/${userId}`,
		{
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				custom_user_properties: { [internalName]: value },
				append_custom_user_properties: true,
			}),
		},
		`user update for ${userId}`,
		'solidarity',
		{ retriesUsed: 0 },
	);
	if (!response.ok) {
		throw new Error(`Solidarity user update returned ${response.status}: ${await response.text()}`);
	}
}

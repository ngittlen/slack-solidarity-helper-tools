import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { getSolidarityMembers } from '$lib/server/autocomplete-sources.js';
import { searchSolidarityMembers } from '$lib/server/solidarity-member-search.js';

// Name/email search over the cached Solidarity roster, for the manual-link
// picker. The roster itself never leaves the server — only the handful of
// matches does.

const MIN_QUERY_LENGTH = 2;

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthenticated' }, { status: 401 });
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	const q = (url.searchParams.get('q') ?? '').trim();
	if (q.length < MIN_QUERY_LENGTH) {
		return json(
			{ error: `Type at least ${MIN_QUERY_LENGTH} characters to search.` },
			{ status: 400 },
		);
	}

	// Stale-while-revalidate: answer from the last fetched roster immediately and
	// let any refresh run in the background. A cold walk takes about two minutes,
	// which is not something to put in front of an admin mid-search — an hour-old
	// roster answers "which account is this person?" just as well.
	//
	// This also means the call no longer throws: a failed refresh keeps serving
	// the retained list, so there is no 503 path left here.
	const { items, stale, fetchedAt, refreshing } = await getSolidarityMembers(SOLIDARITY_API_TOKEN, {
		staleWhileRevalidate: true,
	});

	return json({
		items: searchSolidarityMembers(items, q),
		stale,
		fetchedAt,
		refreshing: refreshing === true,
		// Distinguishes "still building the first list" from "searched, no match",
		// which look identical from an empty result array.
		firstFetch: refreshing === true && fetchedAt === 0,
	});
};

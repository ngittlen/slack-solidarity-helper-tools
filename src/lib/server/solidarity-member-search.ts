// Server-side search over the cached Solidarity roster, for the manual-link
// picker on the member page.
//
// This exists because Solidarity's `GET /v1/users` filters by exact email or
// phone and has no name search at all — so "find me the Solidarity account for
// someone called Jordan" can only be answered by holding the roster and
// searching it ourselves. The roster stays server-side (it's thousands of
// names and emails); the browser only ever sees the handful of hits.

import type { SolidarityMemberEntry } from './autocomplete-sources.js';

export interface MemberSearchHit {
	id: number;
	label: string;
	/** Shown under the label in the picker. See the note below — this is the
	 *  email that *matched*, not necessarily the member's primary one. */
	sublabel: string;
}

const DEFAULT_LIMIT = 25;

// Lower is better.
const RANK_NAME_PREFIX = 0;
const RANK_NAME_SUBSTRING = 1;
const RANK_EMAIL = 2;

interface Scored {
	hit: MemberSearchHit;
	rank: number;
	name: string;
}

/**
 * Rank: name-prefix matches first, then name substrings, then email matches;
 * alphabetical within each band.
 *
 * The `sublabel` contract is load-bearing and easy to get wrong. `AutocompletePicker`
 * re-runs `filterPickerItems` on the client over whatever items it is given, and
 * that helper only looks at `label` and `sublabel`. So if the server matched a
 * member on their third alternate email but the sublabel showed their primary
 * one, the client filter would immediately hide the result the server just
 * found — the picker would look broken for exactly the alternate-email case
 * this feature exists to handle. Returning the matched email keeps both filters
 * in agreement.
 */
export function searchSolidarityMembers(
	items: SolidarityMemberEntry[],
	query: string,
	limit = DEFAULT_LIMIT,
): MemberSearchHit[] {
	const q = query.trim().toLowerCase();
	if (q === '') return [];

	const scored: Scored[] = [];

	for (const item of items) {
		const name = item.name ?? '';
		const lowerName = name.toLowerCase();

		if (lowerName.startsWith(q)) {
			scored.push({ hit: hit(item, item.email), rank: RANK_NAME_PREFIX, name });
			continue;
		}
		if (lowerName.includes(q)) {
			scored.push({ hit: hit(item, item.email), rank: RANK_NAME_SUBSTRING, name });
			continue;
		}

		const matchedEmail = findMatchingEmail(item, q);
		if (matchedEmail !== null) {
			scored.push({ hit: hit(item, matchedEmail), rank: RANK_EMAIL, name });
		}
	}

	scored.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
	return scored.slice(0, limit).map((s) => s.hit);
}

function hit(item: SolidarityMemberEntry, email: string): MemberSearchHit {
	return {
		id: item.id,
		label: item.name,
		// An entry with no email at all still needs a distinguishable sublabel,
		// otherwise two people with the same name are indistinguishable in the
		// picker and the admin can't tell which one to link.
		sublabel: email || `Solidarity ID ${item.id}`,
	};
}

/** The first of the member's emails containing the query, primary first. */
function findMatchingEmail(item: SolidarityMemberEntry, q: string): string | null {
	if (item.email && item.email.toLowerCase().includes(q)) return item.email;
	for (const other of item.otherEmails ?? []) {
		if (other.toLowerCase().includes(q)) return other;
	}
	return null;
}

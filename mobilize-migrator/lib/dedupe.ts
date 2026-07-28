// Duplicate detection against what already exists in Mobilize.
//
// Titles are not stable across the two systems — Solidarity's "Marquette County
// Abdul El-Sayed Canvass Launch & Debate Watch Party!" is Mobilize's "Abdul
// El-Sayed Canvass Launch & Debate Watch Party in Negaunee!" — so an exact
// title match alone would re-create dozens of events. We treat an event as
// already migrated when EITHER the normalized titles match, OR a start instant
// matches and the titles/cities agree closely.
//
// This errs toward calling things duplicates: a missed duplicate creates a
// confusing double-listed event that volunteers can sign up for, while a false
// duplicate just means one event needs creating by hand.

import type { MobilizeEvent } from './mobilize.js';
import type { PlannedEvent } from './transform.js';

const STOPWORDS = new Set([
	'the',
	'a',
	'an',
	'and',
	'with',
	'for',
	'at',
	'in',
	'on',
	'of',
	'to',
	'w',
	'abdul',
	'elsayed',
	'el',
	'sayed',
	'dr',
	'senate',
]);

export function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function tokens(title: string): Set<string> {
	return new Set(
		normalizeTitle(title)
			.split(' ')
			.filter((t) => t.length > 1 && !STOPWORDS.has(t)),
	);
}

/** Jaccard overlap of significant tokens. */
export function titleSimilarity(a: string, b: string): number {
	const left = tokens(a);
	const right = tokens(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	return shared / (left.size + right.size - shared);
}

export interface DuplicateMatch {
	mobilizeEventId: number;
	mobilizeTitle: string;
	reason: string;
}

/** Start instants count as the same shift if they land within this window. */
const START_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * Cities agree if they're equal, one is a prefix of the other ("Canton" vs
 * "Canton Township"), or one side simply isn't recorded.
 *
 * This guard matters more than the title score. The campaign runs the same
 * generically-named event in many cities on the same night — "Debate Watch
 * Party" in Coldwater, Lansing, Pontiac and Oakland all at 7:15pm — and title
 * overlap alone marks all of them as duplicates of each other.
 */
function citiesAgree(plannedCity: string, candidateCity: string): boolean {
	if (!plannedCity || !candidateCity) return true;
	return (
		plannedCity === candidateCity ||
		plannedCity.startsWith(`${candidateCity} `) ||
		candidateCity.startsWith(`${plannedCity} `)
	);
}

export function findDuplicate(
	planned: PlannedEvent,
	existing: MobilizeEvent[],
): DuplicateMatch | null {
	const plannedNorm = normalizeTitle(planned.title);
	const plannedCity = normalizeTitle(planned.city);

	for (const candidate of existing) {
		const candidateNorm = normalizeTitle(candidate.title);
		if (plannedNorm && plannedNorm === candidateNorm) {
			return {
				mobilizeEventId: candidate.id,
				mobilizeTitle: candidate.title,
				reason: 'identical title',
			};
		}

		const sharesStart = candidate.timeslots.some((slot) =>
			planned.startInstants.some(
				(instant) => Math.abs(slot.start_date * 1000 - instant) <= START_TOLERANCE_MS,
			),
		);
		if (!sharesStart) continue;

		const candidateCity = normalizeTitle(candidate.location?.locality ?? '');
		if (!citiesAgree(plannedCity, candidateCity)) continue;

		const similarity = titleSimilarity(planned.title, candidate.title);
		const knownSameCity = Boolean(plannedCity && candidateCity);
		// Same city is itself strong evidence, so accept a weaker title match
		// there than when the city is unknown on one side.
		const threshold = knownSameCity ? 0.25 : 0.5;
		if (similarity >= threshold) {
			return {
				mobilizeEventId: candidate.id,
				mobilizeTitle: candidate.title,
				reason: knownSameCity
					? `same start time, same city (${candidate.location?.locality}), ${Math.round(similarity * 100)}% title overlap`
					: `same start time and ${Math.round(similarity * 100)}% title overlap`,
			};
		}
	}
	return null;
}

// The text filter above a long table.
//
// A table that renders a page at a time keeps the rest of its rows out of the
// DOM, so the browser's find-in-page cannot reach them. The filter box is the
// way to: it runs over every row the page holds, rendered or not.

/**
 * Whether a row's fields match what was typed. Ignores case, and each word
 * typed must appear in some field — "kent dana" finds Dana's turf in Kent
 * whichever column each word is in. An empty filter matches everything.
 */
export function matchesText(
	query: string,
	fields: readonly (string | null | undefined)[],
): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return true;
	const haystack = fields
		.filter((field): field is string => typeof field === 'string')
		.map((field) => field.toLowerCase());
	return words.every((word) => haystack.some((field) => field.includes(word)));
}

/**
 * How long typing has to pause before a filter box applies what was typed.
 * Applying on every keystroke re-filters a long table, or reloads the activity
 * history, between keys, and the box falls behind the typing. Enter, or
 * emptying the box, applies at once.
 */
export const FILTER_DELAY_MS = 500;

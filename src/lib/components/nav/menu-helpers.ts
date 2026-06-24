// Pure-function helpers for the header user menu. Extracted from
// `UserMenu.svelte` so the active-item-match guarantee is
// unit-testable without standing up JSDOM and Bits UI's portal machinery.
//

/**
 * Returns `true` when `pathname` represents the same route as `itemHref`.
 * Comparison normalizes one trailing slash off each input, strips any query
 * string or hash from `pathname`, and compares case-sensitively. Sub-paths
 * are NOT considered current (`/pending` does not match `/pending/anything`).
 */
export function isCurrentPath(itemHref: string, pathname: string): boolean {
	const cleanedPathname = pathname.split(/[?#]/)[0] ?? '';
	return stripTrailingSlash(itemHref) === stripTrailingSlash(cleanedPathname);
}

/**
 * Strips exactly one trailing slash, guarded against collapsing the root path
 * `'/'` into the empty string (which would change comparison semantics).
 */
function stripTrailingSlash(s: string): string {
	return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

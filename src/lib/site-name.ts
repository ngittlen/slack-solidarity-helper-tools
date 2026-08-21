// The site's own name, shown after each page's title in the browser tab.
//
// Pure and shared so the server, the layout and the settings editor all agree
// on the default and on how a title is composed. Kept out of $lib/server
// because the editor and the layout both need it in the browser.

/** Used when the setting is unset or blank. Matches src/error.html, which is a
 *  static file and cannot read the database — if you change this, change that
 *  too, because it is the one place the name is duplicated. */
export const DEFAULT_SITE_NAME = 'Campaign Helper Tools';

export const SITE_NAME_MAX_LENGTH = 60;

/** '' means "not configured" — the same NULL-vs-empty convention the other
 *  app_config text fields use, where clearing a field writes '' rather than
 *  NULL (NULL is reserved for "leave as-is" on the save path). */
export function resolveSiteName(stored: string | null | undefined): string {
	const trimmed = (stored ?? '').trim();
	return trimmed === '' ? DEFAULT_SITE_NAME : trimmed;
}

/**
 * The document title: "Dashboard — A4M Helper Tools".
 *
 * Falls back to the site name alone when a page has no title of its own, rather
 * than rendering a dangling separator. An en dash rather than a hyphen because
 * this is a separator between two names, not a compound word.
 */
export function documentTitle(pageTitle: string | undefined | null, siteName: string): string {
	const page = (pageTitle ?? '').trim();
	const site = resolveSiteName(siteName);
	return page === '' ? site : `${page} — ${site}`;
}

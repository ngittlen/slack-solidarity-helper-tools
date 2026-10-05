// The pages a signed-out visitor may read.
//
// Everything else on this site is behind the root layout's session guard, which
// is the right default: the app is an organising tool, not a public site. The
// policies are the deliberate exception. A privacy policy that only signed-in
// workspace members can read fails the one job it has — it is written for the
// volunteer deciding whether to hand over a phone number, and for anyone asking
// what this deployment does with data, neither of whom has an account yet. It
// is also the URL a Slack app listing has to point at.
//
// Kept as a list here, rather than as an `if` in the layout, so it is one
// grep-able place and so the tests can assert the shape of it. Adding to it is
// a decision to publish a page to the entire internet: nothing behind these
// paths may read the session, and nothing may leak member data.
//
// It is consulted by the ROOT LAYOUT's load, so it governs pages. `/privacy`,
// `/security` and `/terms` are `+server.ts` endpoints, which never run a layout
// load and were therefore never gated by it — they are listed anyway, because
// this is the record of what this deployment serves without a session and a
// list that omitted public URLs would be a worse record than a redundant one.
// If any of them ever becomes a page, it is already covered. `/terms` in
// particular is the terms-of-service URL Google's sign-in consent screen links
// to, so it must answer anyone.

/** Page routes served without a session. Prefix matches, so `/policies#x` and
 *  `/policies?print=1` are covered too. */
const PUBLIC_PREFIXES = ['/policies', '/privacy', '/security', '/terms'];

/**
 * Page routes served without a session at exactly this path, and NOT below it.
 *
 * `/turfs` is here because its load has a signed-out branch: a teaser for
 * people who might canvass, built from coarse aggregates only (see
 * $lib/server/van/nearby-summary.ts). It cannot be a prefix — `/turfs/organizer`,
 * `/turfs/activity` and the map pages under it are organizer tools, and a
 * prefix match would publish them. The signed-in branch of the same load keeps
 * its own session check, as every turf route does.
 *
 * `/signin` is the page every signed-out redirect lands on, so it is public by
 * necessity. It reads the session only to send an already-signed-in visitor
 * on, and shows nothing but the two sign-in buttons.
 */
const PUBLIC_EXACT = ['/turfs', '/signin'];

/** True when `path` is readable without signing in. */
export function isPublicPath(path: string): boolean {
	// Normalise a trailing slash so `/policies/` matches `/policies`.
	const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
	if (PUBLIC_EXACT.includes(normalized)) return true;
	return PUBLIC_PREFIXES.some(
		(prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
	);
}

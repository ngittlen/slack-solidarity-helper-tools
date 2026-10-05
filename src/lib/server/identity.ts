// Who a session belongs to, across the two ways in.
//
// Slack was the only sign-in for most of this app's life, so the session field
// and every turf column that names a person are called `slackUserId`. Google
// sign-in (specs/013-google-sso-login) reuses them rather than renaming ~30
// files and a dozen columns: a Google volunteer's id is `google:<sub>`, stored
// in exactly the places a Slack id goes.
//
// That is safe because the two can never collide — Slack ids are `U…`/`W…`
// and never contain a colon — and because the turf code only ever uses the id
// as an opaque key (claims, the block list, the rate limiters). The places that
// hand an id to Slack itself are the ones that must check first; sendDm is the
// first of them.
//
// So read `slackUserId` as "holder id". `authProvider` on the session says
// which kind it is without parsing the string.

export const GOOGLE_ID_PREFIX = 'google:';

/** The holder id for a Google account, from the id token's stable `sub`. */
export function googleUserId(sub: string): string {
	return `${GOOGLE_ID_PREFIX}${sub}`;
}

/** True for an id minted by googleUserId — one Slack has never heard of. */
export function isGoogleUserId(id: string): boolean {
	return id.startsWith(GOOGLE_ID_PREFIX);
}

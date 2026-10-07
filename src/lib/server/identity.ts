// Who a session belongs to, across the three ways in.
//
// Slack was the only sign-in for most of this app's life, so the session field
// and every turf column that names a person are called `slackUserId`. Google
// sign-in (specs/013-google-sso-login) reuses them rather than renaming ~30
// files and a dozen columns: a Google volunteer's id is `google:<sub>`, stored
// in exactly the places a Slack id goes.
//
// That is safe because they can never collide — Slack ids are `U…`/`W…`
// and never contain a colon — and because the turf code only ever uses the id
// as an opaque key (claims, the block list, the rate limiters). The places that
// hand an id to Slack itself are the ones that must check first; sendDm is the
// first of them.
//
// Apple sign-in (specs/014-apple-sso-login) does the same with `apple:<sub>`.
// Google and Apple volunteers are "outside" volunteers: signed in without
// Slack, confined to turf checkout, and never reachable over Slack.
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

export const APPLE_ID_PREFIX = 'apple:';

/** The holder id for an Apple ID, from the id token's stable `sub`. */
export function appleUserId(sub: string): string {
	return `${APPLE_ID_PREFIX}${sub}`;
}

/** True for an id minted by appleUserId. */
export function isAppleUserId(id: string): boolean {
	return id.startsWith(APPLE_ID_PREFIX);
}

/** The ways in that are not Slack. */
export type OutsideProvider = 'google' | 'apple';

/** True for a Google or Apple holder: someone with no Slack account to reach. */
export function isOutsideUserId(id: string): boolean {
	return isGoogleUserId(id) || isAppleUserId(id);
}

/** Which way in a holder id came from. */
export function providerOf(id: string): 'slack' | OutsideProvider {
	if (isGoogleUserId(id)) return 'google';
	if (isAppleUserId(id)) return 'apple';
	return 'slack';
}

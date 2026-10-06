// Kept apart from slack-authorize.ts so the Google and Apple flows can share it
// without importing the Slack client.

import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { OAUTH_REDIRECT_COOKIE } from './post-login-redirect.js';
import { STATE_TTL_MS } from './oauth-state.js';

/**
 * The cookies an outbound authorization leaves behind for its callback: the
 * flow's own values (the state nonce, and for Google the PKCE verifier, for
 * Apple the id-token nonce), plus the page to return to. One helper so every
 * provider sets them with the same lifetime and flags — they live exactly as
 * long as the signed state does.
 *
 * `crossSiteReturn` is for Apple, which comes back by a form POST from its own
 * site (response_mode=form_post, required when asking for name and email).
 * Browsers do not send SameSite=Lax cookies on a cross-site POST, so the
 * callback would never see them and would restart forever. SameSite=None sends
 * them, and must be Secure. What still stops a forged callback is the same as
 * for the other flows: the nonce in the signed state has to match the cookie,
 * and the code has to survive the exchange with our client secret.
 */
export function setOAuthCookies(
	cookies: Cookies,
	values: Record<string, string>,
	destination: string | null,
	{ crossSiteReturn = false }: { crossSiteReturn?: boolean } = {},
): void {
	const options = {
		path: '/',
		httpOnly: true,
		secure: crossSiteReturn || !dev,
		sameSite: crossSiteReturn ? 'none' : 'lax',
		maxAge: STATE_TTL_MS / 1000,
	} as const;
	for (const [name, value] of Object.entries(values)) cookies.set(name, value, options);

	if (destination === null) {
		// A stale cookie from an abandoned login would otherwise hijack this one.
		cookies.delete(OAUTH_REDIRECT_COOKIE, { path: '/' });
	} else {
		cookies.set(OAUTH_REDIRECT_COOKIE, destination, options);
	}
}

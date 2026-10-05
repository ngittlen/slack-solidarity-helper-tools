// Kept apart from slack-authorize.ts so the Google flow can share it without
// importing the Slack client.

import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { OAUTH_REDIRECT_COOKIE } from './post-login-redirect.js';
import { STATE_TTL_MS } from './oauth-state.js';

/**
 * The cookies an outbound authorization leaves behind for its callback: the
 * flow's own values (the state nonce, and for Google the PKCE verifier), plus
 * the page to return to. One helper so both providers set them with the same
 * lifetime and flags — they live exactly as long as the signed state does.
 */
export function setOAuthCookies(
	cookies: Cookies,
	values: Record<string, string>,
	destination: string | null,
): void {
	const options = {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
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

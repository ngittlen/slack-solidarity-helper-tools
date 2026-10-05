import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { googleSignInConfigured } from '$lib/server/env.js';
import { sanitizeRedirectTarget } from '$lib/server/post-login-redirect.js';
import { signState } from '$lib/server/oauth-state.js';
import { setOAuthCookies } from '$lib/server/oauth-cookies.js';
import {
	buildGoogleAuthorizeUrl,
	createPkcePair,
	GOOGLE_PKCE_COOKIE,
	GOOGLE_STATE_COOKIE,
} from '$lib/server/google-signin.js';

// Sign in with Google: the outbound half. The Slack start route's twin — same
// signed state, same cookies, same one-retry rule — plus a PKCE verifier,
// which Google supports and Slack does not.

export const GET: RequestHandler = async ({ url, cookies }) => {
	// Hidden everywhere when unconfigured, so only a hand-typed URL gets here.
	if (!googleSignInConfigured()) error(404, 'Not found');

	const destination = sanitizeRedirectTarget(url.searchParams.get('redirectTo'));
	const isRetry = url.searchParams.get('retry') === '1';

	const { state, nonce } = signState({ destination, isRetry, purpose: 'google-login' });
	const { verifier, challenge } = createPkcePair();

	setOAuthCookies(
		cookies,
		{ [GOOGLE_STATE_COOKIE]: nonce, [GOOGLE_PKCE_COOKIE]: verifier },
		destination,
	);

	redirect(302, buildGoogleAuthorizeUrl({ state, codeChallenge: challenge }));
};

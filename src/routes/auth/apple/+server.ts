import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { appleSignInConfigured } from '$lib/server/env.js';
import { sanitizeRedirectTarget } from '$lib/server/post-login-redirect.js';
import { signState } from '$lib/server/oauth-state.js';
import { setOAuthCookies } from '$lib/server/oauth-cookies.js';
import {
	APPLE_NONCE_COOKIE,
	APPLE_STATE_COOKIE,
	buildAppleAuthorizeUrl,
	createAppleNonce,
} from '$lib/server/apple-signin.js';

// Sign in with Apple: the outbound half. The Google start route's twin — same
// signed state, same one-retry rule — with an id-token nonce in place of the
// PKCE verifier, and cookies that survive Apple's cross-site form post back.

export const GET: RequestHandler = async ({ url, cookies }) => {
	// Hidden everywhere when unconfigured, so only a hand-typed URL gets here.
	if (!appleSignInConfigured()) error(404, 'Not found');

	const destination = sanitizeRedirectTarget(url.searchParams.get('redirectTo'));
	const isRetry = url.searchParams.get('retry') === '1';

	const { state, nonce } = signState({ destination, isRetry, purpose: 'apple-login' });
	const tokenNonce = createAppleNonce();

	setOAuthCookies(
		cookies,
		{ [APPLE_STATE_COOKIE]: nonce, [APPLE_NONCE_COOKIE]: tokenNonce },
		destination,
		{ crossSiteReturn: true },
	);

	redirect(302, buildAppleAuthorizeUrl({ state, nonce: tokenNonce }));
};

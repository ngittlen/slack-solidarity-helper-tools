import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { sanitizeRedirectTarget } from '$lib/server/post-login-redirect.js';
import { redirectToSlackAuthorize } from '$lib/server/slack-authorize.js';

// Login needs nothing from Slack but who you are, and `oauth.v2.access`
// returns `authed_user.id` for any user scope — so ask for one read-only scope
// that grants nothing the bot can't already do, and throw the token away (see
// the callback). The chat:write grant the info commands need is asked for
// separately, and only of admins and moderators who choose to turn it on — see
// ./post-as-you — so nobody else is shown "Perform actions as you".
//
// Not identity.basic, nor the OpenID `openid` scope: Sign in with Slack scopes
// cannot be combined with any other scope in one authorization, and installing
// the app from its settings page requests every configured scope at once — so
// merely listing one next to chat:write makes the install itself fail with
// "Invalid permissions requested".
const LOGIN_USER_SCOPES = ['users:read'];

export const GET: RequestHandler = async ({ url, cookies }) => {
	// The page the visitor was denied, stashed server-side rather than round-
	// tripped through Slack: the callback then reads a value we sanitised
	// ourselves instead of one an attacker could have appended to the URL.
	const redirectTo = sanitizeRedirectTarget(url.searchParams.get('redirectTo'));

	if (dev && (env as Record<string, string | undefined>)['DEV_SLACK_USER_ID']) {
		redirect(
			302,
			redirectTo === null
				? '/auth/dev-login'
				: `/auth/dev-login?redirectTo=${encodeURIComponent(redirectTo)}`,
		);
	}

	// Set by the callback when it restarts a login whose state cookie went
	// missing, and carried into the signed state so the callback can tell a
	// first attempt from the one automatic retry it allows itself. A browser
	// that simply refuses our cookies would otherwise ping-pong forever.
	const isRetry = url.searchParams.get('retry') === '1';

	return redirectToSlackAuthorize({
		cookies,
		userScopes: LOGIN_USER_SCOPES,
		destination: redirectTo,
		isRetry,
		purpose: 'login',
	});
};

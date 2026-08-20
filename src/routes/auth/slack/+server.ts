import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { SLACK_CLIENT_ID, REDIRECT_URI } from '$lib/server/env.js';
import { env } from '$env/dynamic/private';
import { OAUTH_REDIRECT_COOKIE, sanitizeRedirectTarget } from '$lib/server/post-login-redirect.js';
import { POST_AS_USER_SCOPE } from '$lib/server/user-tokens.js';
import { signState } from '$lib/server/oauth-state.js';

const OAUTH_STATE_COOKIE = 'oauth_state';

// Deliberately just the one scope. Slack refuses to issue a token when an
// `identity.*` scope (Sign in with Slack) is requested alongside anything else —
// the whole authorization fails with "Invalid permissions requested" — so
// identity.basic and chat:write cannot be asked for together. We drop
// identity.basic rather than chat:write: `oauth.v2.access` already returns
// `authed_user.id`, which is the only thing identity.basic was giving us, and
// the display name comes from users.info on the bot token instead.
const USER_SCOPES = [POST_AS_USER_SCOPE];

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

	// The nonce is what the cookie holds and what the callback matches on; the
	// rest of the state is signed context that survives a lost cookie jar.
	const { state, nonce } = signState({ destination: redirectTo, isRetry });

	cookies.set(OAUTH_STATE_COOKIE, nonce, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: 600, // 10 minutes
	});

	if (redirectTo === null) {
		// A stale cookie from an abandoned login would otherwise hijack this one.
		cookies.delete(OAUTH_REDIRECT_COOKIE, { path: '/' });
	} else {
		cookies.set(OAUTH_REDIRECT_COOKIE, redirectTo, {
			path: '/',
			httpOnly: true,
			secure: !dev,
			sameSite: 'lax',
			maxAge: 600, // matches the state cookie
		});
	}

	const params = new URLSearchParams({
		client_id: SLACK_CLIENT_ID,
		// chat:write is what lets an info command post as the person who typed it,
		// rather than as the bot with their name pinned on. Requested here, at
		// login, so there is no second authorization dance the first time an admin
		// uses the command. Slack will not add it to tokens it has already issued,
		// so everyone who logged in before this shipped re-authorizes once.
		user_scope: USER_SCOPES.join(','),
		redirect_uri: REDIRECT_URI,
		state,
	});

	redirect(302, `https://slack.com/oauth/v2/authorize?${params}`);
};

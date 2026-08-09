import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { SLACK_CLIENT_ID, REDIRECT_URI } from '$lib/server/env.js';
import { env } from '$env/dynamic/private';
import { OAUTH_REDIRECT_COOKIE, sanitizeRedirectTarget } from '$lib/server/post-login-redirect.js';

const OAUTH_STATE_COOKIE = 'oauth_state';

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

	const state = crypto.randomUUID();

	cookies.set(OAUTH_STATE_COOKIE, state, {
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
		user_scope: 'identity.basic',
		redirect_uri: REDIRECT_URI,
		state,
	});

	redirect(302, `https://slack.com/oauth/v2/authorize?${params}`);
};

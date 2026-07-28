import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { SLACK_CLIENT_ID, REDIRECT_URI } from '$lib/server/env.js';
import { env } from '$env/dynamic/private';

const OAUTH_STATE_COOKIE = 'oauth_state';

export const GET: RequestHandler = async ({ cookies }) => {
	if (dev && (env as Record<string, string | undefined>)['DEV_SLACK_USER_ID']) {
		redirect(302, '/auth/dev-login');
	}

	const state = crypto.randomUUID();

	cookies.set(OAUTH_STATE_COOKIE, state, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: 600, // 10 minutes
	});

	const params = new URLSearchParams({
		client_id: SLACK_CLIENT_ID,
		user_scope: 'identity.basic',
		redirect_uri: REDIRECT_URI,
		state,
	});

	redirect(302, `https://slack.com/oauth/v2/authorize?${params}`);
};

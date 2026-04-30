import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { sessionStore } from '$lib/server/db.js';
import {
	SLACK_CLIENT_ID,
	SLACK_CLIENT_SECRET,
	SLACK_ALLOWED_USER_IDS,
	REDIRECT_URI,
} from '$lib/server/env.js';

interface SlackOAuthResponse {
	ok: boolean;
	authed_user?: { access_token: string };
	error?: string;
}

interface SlackIdentityResponse {
	ok: boolean;
	user?: { id: string; name: string };
	error?: string;
}

const SESSION_MAX_AGE = 8 * 60 * 60;

export const GET: RequestHandler = async ({ url, cookies }) => {
	const errorParam = url.searchParams.get('error');
	if (errorParam) {
		console.error('[auth] Slack OAuth error:', errorParam);
		error(403, 'Access denied.');
	}

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get('oauth_state');

	if (!code || !state || state !== storedState) {
		error(400, 'Invalid OAuth state.');
	}

	cookies.delete('oauth_state', { path: '/' });

	// Exchange code for token
	const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: SLACK_CLIENT_ID,
			client_secret: SLACK_CLIENT_SECRET,
			code,
			redirect_uri: REDIRECT_URI,
		}),
	});

	const tokenData = (await tokenRes.json()) as SlackOAuthResponse;
	if (!tokenData.ok || !tokenData.authed_user?.access_token) {
		console.error('[auth] token exchange failed:', tokenData.error);
		error(502, 'Authentication failed.');
	}

	// Get user identity
	const identityRes = await fetch('https://slack.com/api/users.identity', {
		headers: { Authorization: `Bearer ${tokenData.authed_user.access_token}` },
	});

	const identity = (await identityRes.json()) as SlackIdentityResponse;
	if (!identity.ok || !identity.user?.id) {
		console.error('[auth] identity fetch failed:', identity.error);
		error(502, 'Authentication failed.');
	}

	const userId = identity.user.id;
	if (!SLACK_ALLOWED_USER_IDS.has(userId)) {
		console.warn(`[auth] blocked user: ${userId} (${identity.user.name})`);
		error(403, 'You are not authorised to view this page.');
	}

	// Create session
	const sid = crypto.randomUUID();
	await sessionStore.set(sid, { slackUserId: userId, slackUserName: identity.user.name }, SESSION_MAX_AGE);

	cookies.set('session', sid, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: SESSION_MAX_AGE,
	});

	console.log(`[auth] login: ${identity.user.name} (${userId})`);
	redirect(302, '/pending');
}
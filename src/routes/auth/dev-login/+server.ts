// Dev-only endpoint to bypass Slack OAuth during local development.
// Only active when DEV_SLACK_USER_ID is set. Never present in production
// (the env var is not set there).

import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { sessionStore } from '$lib/server/db.js';

export const GET: RequestHandler = async ({ cookies }) => {
	const devUserId = (env as Record<string, string | undefined>)['DEV_SLACK_USER_ID'];
	if (!devUserId) {
		error(404, 'Not found');
	}

	const sid = crypto.randomUUID();
	await sessionStore.set(sid, { slackUserId: devUserId, slackUserName: 'Dev User' }, 8 * 60 * 60);
	cookies.set('session', sid, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: 8 * 60 * 60,
	});

	redirect(302, '/pending');
};
// Creating a session, once both sign-in callbacks have decided who someone is.
//
// One function rather than a copy in each callback so a Slack session and a
// Google session cannot drift apart in lifetime or cookie flags — the cookie
// is the whole of the login, and hooks.server.ts reads both the same way.

import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { sessionStore, type SessionData } from './db.js';

/** Eight hours, for every kind of session. */
export const SESSION_MAX_AGE = 8 * 60 * 60;

export async function startSession(cookies: Cookies, data: SessionData): Promise<void> {
	const sid = crypto.randomUUID();
	await sessionStore.set(sid, data, SESSION_MAX_AGE);
	cookies.set('session', sid, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: SESSION_MAX_AGE,
	});
}

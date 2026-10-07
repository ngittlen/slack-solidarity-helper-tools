// Creating a session, once a sign-in callback has decided who someone is.
//
// One function rather than a copy in each callback so Slack, Google and Apple
// sessions cannot drift apart in lifetime or cookie flags — the cookie
// is the whole of the login, and hooks.server.ts reads them all the same way.

import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { sessionStore, type SessionData } from './db.js';
import { LAST_SIGNIN_COOKIE, LAST_SIGNIN_MAX_AGE } from './last-signin.js';

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
	cookies.set(LAST_SIGNIN_COOKIE, data.authProvider ?? 'slack', {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: LAST_SIGNIN_MAX_AGE,
	});
}

/**
 * Rewrite the current session in place — same id, same cookie, the life it
 * already had left. For the one change a session takes after sign-in: an
 * outside volunteer giving the name /turfs asked for. False when there is no
 * live session to rewrite.
 */
export async function updateSession(cookies: Cookies, data: SessionData): Promise<boolean> {
	const sid = cookies.get('session');
	if (!sid) return false;
	return sessionStore.update(sid, data);
}

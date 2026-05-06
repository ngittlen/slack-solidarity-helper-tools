import type { Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { sessionStore } from '$lib/server/db.js';
import { validateEnv } from '$lib/server/env.js';

export async function init() {
	validateEnv();
}

export const handle: Handle = async ({ event, resolve }) => {
	const sid = event.cookies.get('session');

	if (sid) {
		const sessionData = await sessionStore.get(sid);
		if (sessionData) {
			event.locals.session = sessionData;
			event.cookies.set('session', sid, {
				path: '/',
				httpOnly: true,
				secure: !dev,
				sameSite: 'lax',
				maxAge: 8 * 60 * 60,
			});
		} else {
			event.locals.session = null;
			event.cookies.delete('session', { path: '/' });
		}
	} else {
		event.locals.session = null;
	}

	return resolve(event);
};

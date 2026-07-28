import type { Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { sessionStore } from '$lib/server/db.js';
import { validateEnv } from '$lib/server/env.js';

export async function init() {
	validateEnv();
	// DEV_SLACK_USER_ID enables the no-auth admin backdoor at /auth/dev-login.
	// The endpoint itself also requires dev mode, but refuse to boot at all if
	// the var leaks into a production environment (e.g. a copied .env).
	if (!dev && (env as Record<string, string | undefined>)['DEV_SLACK_USER_ID']) {
		console.error(
			'DEV_SLACK_USER_ID must not be set in production — it enables the dev-login auth bypass.',
		);
		process.exit(1);
	}
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

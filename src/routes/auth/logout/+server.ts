import type { RequestHandler } from './$types';
import { redirect } from '@sveltejs/kit';
import { db, sessionStore } from '$lib/server/db.js';
import { releasePushDevice } from '$lib/server/push.js';
import { errMessage } from '$lib/err-message.js';

export const POST: RequestHandler = async ({ cookies, locals, request }) => {
	// The root layout sends this browser's push address, when it has one: the
	// person logging out stops being the one its notifications are for, so a
	// shared device does not keep showing their turf (src/lib/server/push.ts).
	// Never in the way of logging out.
	if (locals.session) {
		try {
			const endpoint = (await request.formData()).get('push_endpoint');
			if (typeof endpoint === 'string' && endpoint !== '') {
				await releasePushDevice(db, locals.session.slackUserId, endpoint);
			}
		} catch (err) {
			console.warn('[push] could not release a device on logout:', errMessage(err));
		}
	}
	const sid = cookies.get('session');
	if (sid) {
		await sessionStore.destroy(sid);
	}
	cookies.delete('session', { path: '/' });
	redirect(303, '/');
};

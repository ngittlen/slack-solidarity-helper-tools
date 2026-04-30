import type { RequestHandler } from './$types';
import { sessionStore } from '$lib/server/db.js';

export const POST: RequestHandler = async ({ cookies }) => {
	const sid = cookies.get('session');
	if (sid) {
		await sessionStore.destroy(sid);
	}
	cookies.delete('session', { path: '/' });
	return new Response('Logged out.');
};
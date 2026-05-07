import type { RequestHandler } from './$types';
import { redirect } from '@sveltejs/kit';
import { sessionStore } from '$lib/server/db.js';

export const POST: RequestHandler = async ({ cookies }) => {
	const sid = cookies.get('session');
	if (sid) {
		await sessionStore.destroy(sid);
	}
	cookies.delete('session', { path: '/' });
	redirect(303, '/');
};
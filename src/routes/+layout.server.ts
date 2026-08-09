import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { loginRedirectPath } from '$lib/server/post-login-redirect.js';

export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.session) {
		// Carry the requested page through OAuth so login returns them to it.
		redirect(302, loginRedirectPath(url));
	}
	return {
		userName: locals.session.slackUserName,
		isAdmin: locals.session.isAdmin,
	};
};

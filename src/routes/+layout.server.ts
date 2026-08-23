import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { loginRedirectPath } from '$lib/server/post-login-redirect.js';
import { parseThemeMode, THEME_COOKIE } from '$lib/theme-mode.js';
import { db } from '$lib/server/db.js';
import { getSiteName } from '$lib/server/site.js';

export const load: LayoutServerLoad = async ({ locals, url, cookies }) => {
	if (!locals.session) {
		// Carry the requested page through OAuth so login returns them to it.
		redirect(302, loginRedirectPath(url));
	}
	return {
		userName: locals.session.slackUserName,
		isAdmin: locals.session.isAdmin,
		// Same cookie hooks.server.ts used to stamp <html>, so the toggle's first
		// render agrees with the markup already on screen.
		themeMode: parseThemeMode(cookies.get(THEME_COOKIE)),
		// Cached; see server/site.ts. Every page's <title> ends with this.
		siteName: await getSiteName(db),
	};
};

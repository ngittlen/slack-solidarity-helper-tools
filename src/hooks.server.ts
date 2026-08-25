import type { Handle } from '@sveltejs/kit';
import { text } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { db, sessionStore } from '$lib/server/db.js';
import { getTheme } from '$lib/server/theme.js';
import { parseThemeMode, themeAttribute, THEME_COOKIE } from '$lib/theme-mode.js';
import { errMessage } from '$lib/err-message.js';
import { validateEnv } from '$lib/server/env.js';
import { isCrossSiteFormPost } from '$lib/server/csrf.js';

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
	// Stands in for SvelteKit's own CSRF check, which is disabled in
	// svelte.config.js so Slack's Origin-less form posts can reach
	// /api/slack/*. Matches Kit's dev exemption so local form testing behaves
	// the same as before. See src/lib/server/csrf.ts for the full rationale.
	if (!dev && isCrossSiteFormPost(event.request, event.url)) {
		return text(`Cross-site ${event.request.method} form submissions are forbidden`, {
			status: 403,
		});
	}

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

	// Inject the theme's custom properties into <head>. Done here rather than in
	// a layout because it has to reach <html>/<body> — a wrapper div can set
	// variables for its subtree but cannot colour the page background, and dark
	// mode needs somewhere above the app to hang.
	//
	// Never let a theming failure cost the user their page: on error the
	// placeholder is stripped and the app renders with app.css's own fallbacks.
	let themeStyle = '';
	try {
		const { css } = await getTheme(db);
		themeStyle = `<style id="theme-tokens">${css}</style>`;
	} catch (err) {
		console.error('[theme] injection failed, rendering without tokens:', errMessage(err));
	}

	// The viewer's own light/dark choice, stamped on <html> server-side.
	//
	// A cookie rather than localStorage precisely so it can be read HERE: an
	// inline script reading localStorage would run after first paint, which is
	// the flash-of-wrong-theme this whole design avoids. 'system' writes no
	// attribute at all, leaving prefers-color-scheme in charge.
	// Note the replaced token includes the space BEFORE it: themeAttribute
	// carries its own leading space, so 'system' collapses to `<html lang="en">`
	// rather than leaving a stray one.
	const themeAttr = themeAttribute(parseThemeMode(event.cookies.get(THEME_COOKIE)));

	return resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace('%theme.style%', themeStyle).replace(' %theme.attr%', themeAttr),
	});
};

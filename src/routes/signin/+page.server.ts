import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { appleSignInConfigured, googleSignInConfigured } from '$lib/server/env.js';
import {
	resolvePostLoginRedirect,
	sanitizeRedirectTarget,
	withRedirectTo,
} from '$lib/server/post-login-redirect.js';
import { LAST_SIGNIN_COOKIE, parseLastSignIn } from '$lib/server/last-signin.js';

// The one sign-in page. Every signed-out redirect in the app lands here (see
// loginRedirectPath), and it offers every way in that is configured: Slack for
// members and organizers, Google and Apple for volunteers who only want turf
// checkout.
//
// Public by exact path (server/public-paths.ts). The session is read only to
// send someone who is already signed in on to where they were going.

/** Which provider's screen a volunteer cancelled on, from `?cancelled=`. */
function cancelledAt(raw: string | null): 'google' | 'apple' | null {
	return raw === 'google' || raw === 'apple' ? raw : null;
}

export const load: PageServerLoad = async ({ locals, url, cookies }) => {
	const destination = sanitizeRedirectTarget(url.searchParams.get('redirectTo'));

	if (locals.session) redirect(302, resolvePostLoginRedirect(destination, locals.session));

	const slackHref = withRedirectTo('/auth/slack', destination);
	const googleHref = googleSignInConfigured() ? withRedirectTo('/auth/google', destination) : null;
	const appleHref = appleSignInConfigured() ? withRedirectTo('/auth/apple', destination) : null;

	// With neither of the others configured there is only one way in, and a
	// page with one button is a click nobody needs: straight on to Slack, as
	// before this page existed.
	if (googleHref === null && appleHref === null) redirect(302, slackHref);

	// Marked only when that button is on the page — a Google sign-in from
	// before Google was switched off points at nothing.
	const last = parseLastSignIn(cookies.get(LAST_SIGNIN_COOKIE));
	const offered = { slack: true, google: googleHref !== null, apple: appleHref !== null };

	return {
		pageTitle: 'Sign in',
		slackHref,
		googleHref,
		appleHref,
		cancelled: cancelledAt(url.searchParams.get('cancelled')),
		lastUsed: last !== null && offered[last] ? last : null,
	};
};

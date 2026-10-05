import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { googleSignInConfigured } from '$lib/server/env.js';
import {
	resolvePostLoginRedirect,
	sanitizeRedirectTarget,
	withRedirectTo,
} from '$lib/server/post-login-redirect.js';

// The one sign-in page. Every signed-out redirect in the app lands here (see
// loginRedirectPath), and it offers both ways in: Slack for members and
// organizers, Google for volunteers who only want turf checkout.
//
// Public by exact path (server/public-paths.ts). The session is read only to
// send someone who is already signed in on to where they were going.

export const load: PageServerLoad = async ({ locals, url }) => {
	const destination = sanitizeRedirectTarget(url.searchParams.get('redirectTo'));

	if (locals.session) redirect(302, resolvePostLoginRedirect(destination, locals.session));

	const slackHref = withRedirectTo('/auth/slack', destination);

	// Without a Google client there is only one way in, and a page with one
	// button is a click nobody needs: straight on to Slack, as before this page
	// existed.
	if (!googleSignInConfigured()) redirect(302, slackHref);

	return {
		pageTitle: 'Sign in',
		slackHref,
		googleHref: withRedirectTo('/auth/google', destination),
		cancelled: url.searchParams.get('cancelled') === '1',
	};
};

import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { POST_AS_USER_SCOPE } from '$lib/server/user-tokens.js';
import { redirectToSlackAuthorize } from '$lib/server/slack-authorize.js';

// Where the info commands' "needs your permission" reply points, and what the
// button on /post-as-you links to. Asks for chat:write on its own — the one
// thing the info commands need to post as the person running them — and only
// of someone already signed in as an admin or moderator, so nobody else is
// ever shown "Perform actions as you".

/** Where to land once Slack hands back the grant. */
const DESTINATION = '/post-as-you';

export const GET: RequestHandler = async ({ url, locals, cookies }) => {
	const session = locals.session;
	if (!session) {
		// Sign in first; /post-as-you then offers the button. Not straight back
		// here — sanitizeRedirectTarget refuses /auth/* destinations, and a
		// second Slack screen right after the first, with no explanation, is
		// exactly the surprise this split exists to avoid.
		redirect(302, `/auth/slack?redirectTo=${encodeURIComponent(DESTINATION)}`);
	}
	if (!session.isAdmin && !session.isModerator) {
		error(403, 'Only admins and moderators can use the info commands.');
	}

	return redirectToSlackAuthorize({
		cookies,
		userScopes: [POST_AS_USER_SCOPE],
		destination: DESTINATION,
		isRetry: url.searchParams.get('retry') === '1',
		purpose: 'post-as-you',
	});
};

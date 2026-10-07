import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db.js';
import { deleteUserToken, loadUserToken, revokeUserToken } from '$lib/server/user-tokens.js';
import { errMessage } from '$lib/err-message.js';

// Whether the info commands may post as the signed-in admin or moderator, and
// the switch to turn that off.
//
// "On" means a usable token is stored, not that Slack still honours it — the
// person can revoke it from Slack's side without us hearing. So the way to
// grant it again stays on the page either way. Turning it on is a link to
// /auth/slack/post-as-you, which asks Slack for chat:write; the callback
// stores the grant and lands back here.

export interface PostAsYouPageData {
	pageTitle: 'Post as you';
	enabled: boolean;
}

function requireInfoCommandUser(session: App.Locals['session']): string {
	// Checked here, not just in the layout — layout and page loads run
	// concurrently, so an unauthenticated request still reaches this function.
	if (!session?.isAdmin && !session?.isModerator) redirect(302, '/');
	return session.slackUserId;
}

export const load: PageServerLoad = async ({ locals }) => {
	const slackUserId = requireInfoCommandUser(locals.session);
	// An unreadable or pre-chat:write row reads as off — the info commands
	// would refuse it too, and the button fixes it.
	const lookup = await loadUserToken(db, slackUserId);
	return { pageTitle: 'Post as you', enabled: lookup.ok } satisfies PostAsYouPageData;
};

export const actions: Actions = {
	turnOff: async ({ locals }) => {
		const slackUserId = requireInfoCommandUser(locals.session);
		const lookup = await loadUserToken(db, slackUserId);

		// Forgotten here first: if that fails nothing has changed anywhere, and
		// the page can say so. The other order could leave a dead token stored
		// that the page would go on calling "on".
		try {
			await deleteUserToken(db, slackUserId);
		} catch (err) {
			console.error(`[post-as-you] delete failed for ${slackUserId}:`, errMessage(err));
			return fail(500, { error: 'Could not turn it off just now. Please try again.' });
		}

		// Then revoked at Slack, so "off" also means the token stops working
		// rather than just that we stopped using it. Reported back rather than
		// assumed: an unreadable row can't be revoked at all, and Slack can say
		// no. Either way the token is gone from this app.
		const revoked = lookup.ok ? await revokeUserToken(lookup.token, slackUserId) : false;
		console.log(`[post-as-you] turned off for ${slackUserId} (revoked at Slack: ${revoked})`);
		return { turnedOff: true, revoked };
	},
};

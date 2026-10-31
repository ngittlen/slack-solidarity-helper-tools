// The outbound half of a Slack authorization: mint the signed state, cookie
// its nonce, and send the browser to Slack. Shared by the two flows that come
// back through auth/slack/callback — signing in, and an admin or moderator
// letting the info commands post as them — which differ only in the scope
// they ask for and the purpose they sign into the state.

import { redirect, type Cookies } from '@sveltejs/kit';
import { SLACK_CLIENT_ID, REDIRECT_URI } from './env.js';
import { signState, type OAuthPurpose } from './oauth-state.js';
import { setOAuthCookies } from './oauth-cookies.js';
import { workspaceTeamId } from './slack-team.js';

export const OAUTH_STATE_COOKIE = 'oauth_state';

export async function redirectToSlackAuthorize(args: {
	cookies: Cookies;
	/** Comma-joined into `user_scope`. */
	userScopes: readonly string[];
	/** Already sanitised by the caller; null for "nowhere in particular". */
	destination: string | null;
	isRetry: boolean;
	purpose: OAuthPurpose;
}): Promise<never> {
	const { cookies, destination } = args;

	// The nonce is what the cookie holds and what the callback matches on; the
	// rest of the state is signed context that survives a lost cookie jar.
	const { state, nonce } = signState({
		destination,
		isRetry: args.isRetry,
		purpose: args.purpose,
	});

	setOAuthCookies(cookies, { [OAUTH_STATE_COOKIE]: nonce }, destination);

	const params = new URLSearchParams({
		client_id: SLACK_CLIENT_ID,
		user_scope: args.userScopes.join(','),
		redirect_uri: REDIRECT_URI,
		state,
	});
	// Skips Slack's "enter your workspace" page for someone who is not signed in
	// to Slack in this browser yet. Left off when the lookup fails; see
	// server/slack-team.ts.
	const team = await workspaceTeamId();
	if (team) params.set('team', team);

	redirect(302, `https://slack.com/oauth/v2/authorize?${params}`);
}

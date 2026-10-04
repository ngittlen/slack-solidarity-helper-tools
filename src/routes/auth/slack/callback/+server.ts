import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { db, sessionStore } from '$lib/server/db.js';
import { loadSettings } from '$lib/server/settings.js';
import {
	saveUserToken,
	deleteUserToken,
	loadUserToken,
	revokeUserToken,
	hasScope,
	POST_AS_USER_SCOPE,
} from '$lib/server/user-tokens.js';
import { slack } from '$lib/server/slack.js';
import {
	OAUTH_REDIRECT_COOKIE,
	resolvePostLoginRedirect,
	sanitizeRedirectTarget,
} from '$lib/server/post-login-redirect.js';
import { verifyState, type OAuthPurpose } from '$lib/server/oauth-state.js';
import {
	SLACK_CLIENT_ID,
	SLACK_CLIENT_SECRET,
	SLACK_SUPERUSER_ID,
	REDIRECT_URI,
} from '$lib/server/env.js';

interface SlackOAuthResponse {
	ok: boolean;
	authed_user?: { id?: string; access_token?: string; scope?: string };
	error?: string;
}

const SESSION_MAX_AGE = 8 * 60 * 60;

/** Where a post-as-you grant lands, whichever way it went. */
const POST_AS_YOU_PAGE = '/post-as-you';

export const GET: RequestHandler = async ({ url, cookies, locals }) => {
	const errorParam = url.searchParams.get('error');
	if (errorParam) {
		// Cancel on the post-as-you screen is a perfectly good answer — "don't
		// post as me" — not a failed login, so it goes back to the page that
		// asked rather than to a 403. Only a state we signed gets that (an
		// expired one included: Cancel an hour later is still Cancel), and the
		// worst a forged one could do is show someone that page.
		const errorState = url.searchParams.get('state');
		const errorVerdict = errorState ? verifyState(errorState) : null;
		const errorPurpose = errorVerdict?.ok
			? errorVerdict.state.purpose
			: errorVerdict?.reason === 'expired'
				? errorVerdict.purpose
				: null;
		if (errorPurpose === 'post-as-you') {
			console.log(`[auth] post-as-you not granted: ${errorParam}`);
			cookies.delete('oauth_state', { path: '/' });
			cookies.delete(OAUTH_REDIRECT_COOKIE, { path: '/' });
			redirect(302, `${POST_AS_YOU_PAGE}?declined=1`);
		}
		console.error('[auth] Slack OAuth error:', errorParam);
		error(403, 'Access denied.');
	}

	const code = url.searchParams.get('code');
	const rawState = url.searchParams.get('state');
	const storedNonce = cookies.get('oauth_state');

	if (!code || !rawState) {
		error(400, 'Invalid OAuth state.');
	}

	const verdict = verifyState(rawState);
	if (!verdict.ok) {
		// A signature that does not check out is the only failure here that means
		// somebody tampered with the round trip. Everything else is a browser
		// being a browser, and earns another go.
		if (verdict.reason === 'bad-signature') {
			console.warn('[auth] OAuth state failed signature verification');
			error(400, 'Invalid OAuth state.');
		}
		// `malformed` also covers the states minted by the previous bare-UUID
		// code, so the few in flight across a deploy restart cleanly rather than
		// 400ing. Neither reason can loop: the state we mint next is well-formed
		// and freshly dated by construction. An expired state did pass its
		// signature check, so its destination is ours and rides along.
		console.warn(`[auth] restarting login: OAuth state ${verdict.reason}`);
		if (verdict.reason === 'expired') restart(verdict.purpose, verdict.destination);
		restart('login', null);
	}
	const state = verdict.state;

	if (storedNonce === undefined) {
		// The URL came back but the cookie did not, which is the signature of a
		// login that changed browsers mid-flight: Slack's in-app webview hands the
		// current URL to Safari on "Open in browser", and Safari has its own
		// cookie jar. Nobody is attacking — so start the login over in whichever
		// browser we are in now, and still send them where they were going, since
		// the signed state carried the destination across even though the cookie
		// could not.
		if (!state.isRetry) {
			console.warn('[auth] restarting login: no state cookie (browser handoff?)');
			restart(state.purpose, state.destination);
		}
		// One retry already happened and the cookie still is not sticking, so
		// going round again would only spin. Say what is actually wrong instead.
		console.error('[auth] login abandoned: state cookie missing after a retry');
		error(
			400,
			'Your browser did not send back the login cookie. This usually means the link was opened ' +
				'inside an app’s built-in browser. Open the site directly in your browser and sign in again.',
		);
	}

	if (storedNonce !== state.nonce) {
		// A cookie that is present but *different* is the case this check exists
		// for: someone else's authorization being fed into this browser.
		console.warn('[auth] OAuth state did not match the cookie');
		error(400, 'Invalid OAuth state.');
	}

	// The page they were trying to reach when they got bounced to login. The
	// cookie wins where it survived; the signed state is the fallback for the
	// jars that drop one cookie but not the other. Read before the session
	// exists — whether they may actually see it is decided below, once we know
	// if they're an admin.
	const requestedPath = cookies.get(OAUTH_REDIRECT_COOKIE) ?? state.destination;

	cookies.delete('oauth_state', { path: '/' });
	cookies.delete(OAUTH_REDIRECT_COOKIE, { path: '/' });

	// Everything a grant can be refused for without knowing which Slack account
	// approved it is refused here, before the code is exchanged: an unexchanged
	// code mints no token, so there is nothing left at Slack to clean up.
	if (state.purpose === 'post-as-you') {
		// Started from a signed-in page, so a missing session means it expired
		// or the grant finished in another browser. Either way there is nobody
		// to check the Slack account against; sign in, then press the button
		// again.
		if (!locals.session) {
			redirect(302, `/auth/slack?redirectTo=${encodeURIComponent(POST_AS_YOU_PAGE)}`);
		}
		if (!locals.session.isAdmin && !locals.session.isModerator) {
			error(403, INFO_COMMANDS_ONLY);
		}
	}

	// Exchange code for token
	const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: SLACK_CLIENT_ID,
			client_secret: SLACK_CLIENT_SECRET,
			code,
			redirect_uri: REDIRECT_URI,
		}),
	});

	const tokenData = (await tokenRes.json()) as SlackOAuthResponse;
	if (!tokenData.ok || !tokenData.authed_user?.id) {
		console.error('[auth] token exchange failed:', tokenData.error);
		error(502, 'Authentication failed.');
	}

	// Straight off the token response — no users.identity round trip. It
	// would tell us nothing `authed_user.id` doesn't.
	const userId = tokenData.authed_user.id;
	const accessToken = tokenData.authed_user.access_token;
	const { isAdmin, isModerator, isSuperuser, settingsUnavailable } = await resolveRole(userId);

	if (state.purpose === 'post-as-you') {
		await storePostAsYouGrant({
			// Non-null: checked before the exchange above.
			sessionUserId: locals.session!.slackUserId,
			userId,
			canUseInfoCommands: isAdmin || isModerator,
			settingsUnavailable,
			accessToken,
			scopes: tokenData.authed_user.scope ?? '',
		});
		redirect(302, `${POST_AS_YOU_PAGE}?enabled=1`);
	}

	// The login token itself (users:read) is never kept — it can't post, and
	// the session is all a login needs. What a login *does* do is drop a stored
	// post-as-you token for anyone who is no longer an admin or moderator: the
	// info commands are theirs alone, so holding anyone else's would be holding
	// a credential the app has no use for.
	//
	// Nothing is revoked at Slack here. Revoking every member's authorization
	// on each sign-in could put Slack's Allow screen in front of them every
	// time, and a token the app never stores can't be used anyway.
	//
	// Skipped when the lists could not be read: `isAdmin` false then means
	// "unknown", and clearing a real admin's grant over a database hiccup
	// would be worse than leaving a member's in place until next time.
	if (!isAdmin && !isModerator && !settingsUnavailable) {
		try {
			await deleteUserToken(db, userId);
		} catch (err) {
			console.error(
				'[auth] could not clear a stored user token:',
				err instanceof Error ? err.message : err,
			);
		}
	}

	// Read once and reused for the session and the log line below.
	const userName = await displayName(userId);

	// Create session
	const sid = crypto.randomUUID();
	await sessionStore.set(
		sid,
		{ slackUserId: userId, slackUserName: userName, isAdmin, isModerator },
		SESSION_MAX_AGE,
	);

	cookies.set('session', sid, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: SESSION_MAX_AGE,
	});

	console.log(
		`[auth] login: ${userName} (${userId}) admin=${isAdmin}` +
			`${isModerator ? ' moderator=true' : ''}${isSuperuser ? ' (superuser)' : ''}`,
	);
	// Back to the page they asked for — or the dashboard, when they asked for
	// nothing or for something this session may not see.
	redirect(302, resolvePostLoginRedirect(requestedPath, { isAdmin, isModerator }));
};

/**
 * Send someone back through the authorization they were in the middle of
 * rather than dead-ending them on a 400.
 *
 * Safe by construction: the `code` Slack just handed us is dropped on the floor
 * and a brand-new authorization begins, so nothing from an unverified response
 * ever reaches a session or the token store. `retry=1` is what keeps this to at
 * most one automatic attempt — the start routes fold it into the state they
 * mint, and the callback refuses to restart one that already carries it.
 */
function restart(purpose: OAuthPurpose, destination: string | null): never {
	// post-as-you always lands on its own page, so there is nothing to carry.
	if (purpose === 'post-as-you') redirect(302, '/auth/slack/post-as-you?retry=1');

	const params = new URLSearchParams();
	// Re-sanitised rather than trusted: it is signed, but the rule that only
	// same-origin paths reach a Location header should hold at every hop.
	const target = sanitizeRedirectTarget(destination);
	if (target !== null) params.set('redirectTo', target);
	params.set('retry', '1');
	redirect(302, `/auth/slack?${params}`);
}

/**
 * Admin gate reads the DB-backed allowed list via loadSettings; that table is
 * the only source of admin access. The superuser is admitted without
 * consulting the list — even when reading it fails — so an unreadable
 * allowed_slack_users table can never lock every admin out of /pending and
 * /settings.
 *
 * Moderators come from the same read. An admin is never also flagged a
 * moderator: isModerator only ever widens access for someone who is not an
 * admin, so it is kept meaningful as "moderator and nothing more".
 */
async function resolveRole(userId: string): Promise<{
	isAdmin: boolean;
	isModerator: boolean;
	isSuperuser: boolean;
	/** The lists could not be read, so false above means "unknown", not "no". */
	settingsUnavailable: boolean;
}> {
	const isSuperuser = SLACK_SUPERUSER_ID !== '' && userId === SLACK_SUPERUSER_ID;
	if (isSuperuser) {
		return { isAdmin: true, isModerator: false, isSuperuser, settingsUnavailable: false };
	}
	try {
		const { allowedSlackUserIds, moderatorSlackUserIds } = await loadSettings(db);
		const isAdmin = allowedSlackUserIds.has(userId);
		return {
			isAdmin,
			isModerator: !isAdmin && moderatorSlackUserIds.has(userId),
			isSuperuser,
			settingsUnavailable: false,
		};
	} catch (err) {
		console.error(
			'[auth] loadSettings failed — denying admin and moderator to non-superuser:',
			err instanceof Error ? err.message : err,
		);
		return { isAdmin: false, isModerator: false, isSuperuser, settingsUnavailable: true };
	}
}

const INFO_COMMANDS_ONLY = 'Only admins and moderators can use the info commands.';

/**
 * Keep the chat:write token an admin or moderator just granted, so the info
 * commands can post as them. Throws (as a SvelteKit error) when the grant
 * must not be kept; returns once it is stored.
 *
 * The role is re-read rather than taken from the session, which may be hours
 * old — someone removed from both lists since signing in gets nothing.
 */
async function storePostAsYouGrant(args: {
	sessionUserId: string;
	userId: string;
	canUseInfoCommands: boolean;
	settingsUnavailable: boolean;
	accessToken: string | undefined;
	scopes: string;
}): Promise<void> {
	const { sessionUserId, userId, accessToken } = args;

	// Every refusal from here on comes after Slack has already issued the token,
	// so it is revoked rather than just dropped — otherwise the grant we refused
	// would still stand at Slack. Not when that account already has a grant
	// stored, though: Slack user tokens accumulate, so revoking this one could
	// take a working grant down with it, and nothing new was granted anyway.
	async function refuse(status: number, message: string): Promise<never> {
		if (accessToken) {
			const existing = await loadUserToken(db, userId);
			// Only a definite "nothing stored" is safe to revoke over; a failed
			// read could be hiding a grant.
			if (!existing.ok && existing.reason !== 'error') {
				await revokeUserToken(accessToken, userId);
			}
		}
		error(status, message);
	}

	// Slack lets you pick a workspace account on its screen, and it need not be
	// the one this session belongs to. Storing it would make one person's
	// commands post as someone else.
	if (sessionUserId !== userId) {
		console.warn(
			`[auth] post-as-you: session ${sessionUserId} authorized as ${userId} — not stored`,
		);
		await refuse(
			403,
			'You authorized a different Slack account from the one you are signed in as. ' +
				'Sign in with that account, or authorize again with this one.',
		);
	}
	if (args.settingsUnavailable) {
		await refuse(503, 'Could not check your access just now. Please try again in a moment.');
	}
	if (!args.canUseInfoCommands) {
		// No longer an admin or moderator, so any grant they stored earlier is
		// one the app has no use for either — dropped now rather than at their
		// next sign-in. With it gone, refuse() revokes at Slack too.
		try {
			await deleteUserToken(db, userId);
		} catch (err) {
			console.error(
				'[auth] could not clear a stored user token:',
				err instanceof Error ? err.message : err,
			);
		}
		await refuse(403, INFO_COMMANDS_ONLY);
	}
	if (!accessToken || !hasScope(args.scopes, POST_AS_USER_SCOPE)) {
		console.error(`[auth] post-as-you: Slack returned no chat:write token for ${userId}`);
		await refuse(502, 'Slack did not grant permission to post as you. Please try again.');
		return;
	}
	try {
		await saveUserToken(db, { slackUserId: userId, accessToken, scopes: args.scopes });
	} catch (err) {
		console.error(
			'[auth] could not store the user token:',
			err instanceof Error ? err.message : err,
		);
		await refuse(500, 'Could not save your permission. Please try again.');
	}
	console.log(`[auth] post-as-you enabled for ${userId}`);
}

/**
 * Display name for the session, read with the **bot** token — it already holds
 * `users:read`, and the login's user token is never kept.
 *
 * Never throws: the name is cosmetic (it labels the session and stamps audit
 * rows), and a Slack hiccup must not cost someone their login. Falls back to
 * the raw id, which every caller already tolerates.
 */
async function displayName(slackUserId: string): Promise<string> {
	try {
		const info = await slack.users.info({ user: slackUserId });
		const user = info.user as
			{ name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
		return (
			user?.profile?.display_name?.trim() ||
			user?.profile?.real_name?.trim() ||
			user?.name?.trim() ||
			slackUserId
		);
	} catch (err) {
		console.warn('[auth] could not read a display name:', err instanceof Error ? err.message : err);
		return slackUserId;
	}
}

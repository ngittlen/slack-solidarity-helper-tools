import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dev } from '$app/environment';
import { db, sessionStore } from '$lib/server/db.js';
import { loadSettings } from '$lib/server/settings.js';
import { saveUserToken, deleteUserToken } from '$lib/server/user-tokens.js';
import { slack } from '$lib/server/slack.js';
import {
	OAUTH_REDIRECT_COOKIE,
	resolvePostLoginRedirect,
} from '$lib/server/post-login-redirect.js';
import {
	SLACK_CLIENT_ID,
	SLACK_CLIENT_SECRET,
	SLACK_SUPERUSER_ID,
	REDIRECT_URI,
} from '$lib/server/env.js';

interface SlackOAuthResponse {
	ok: boolean;
	authed_user?: { id?: string; access_token: string; scope?: string };
	error?: string;
}

const SESSION_MAX_AGE = 8 * 60 * 60;

export const GET: RequestHandler = async ({ url, cookies }) => {
	const errorParam = url.searchParams.get('error');
	if (errorParam) {
		console.error('[auth] Slack OAuth error:', errorParam);
		error(403, 'Access denied.');
	}

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get('oauth_state');

	if (!code || !state || state !== storedState) {
		error(400, 'Invalid OAuth state.');
	}

	// The page they were trying to reach when they got bounced to login. Read
	// before the session exists; whether they may actually see it is decided
	// below, once we know if they're an admin.
	const requestedPath = cookies.get(OAUTH_REDIRECT_COOKIE) ?? null;

	cookies.delete('oauth_state', { path: '/' });
	cookies.delete(OAUTH_REDIRECT_COOKIE, { path: '/' });

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
	if (!tokenData.ok || !tokenData.authed_user?.access_token || !tokenData.authed_user.id) {
		console.error('[auth] token exchange failed:', tokenData.error);
		error(502, 'Authentication failed.');
	}

	// Straight off the token response — no users.identity round trip. That call
	// needed the identity.basic scope, which Slack refuses to grant alongside
	// chat:write (see the scope comment in ../+server.ts), and it told us
	// nothing `authed_user.id` doesn't.
	const userId = tokenData.authed_user.id;
	// Admin gate reads the DB-backed allowed list via loadSettings (which falls
	// back to env SLACK_ALLOWED_USER_IDS while the table is empty). The
	// superuser is admitted without consulting the list — even when reading it
	// fails — so a mis-edited or emptied allowed_slack_users table can never
	// lock every admin out of /pending and /settings.
	const isSuperuser = SLACK_SUPERUSER_ID !== '' && userId === SLACK_SUPERUSER_ID;
	let isAdmin = isSuperuser;
	if (!isAdmin) {
		try {
			isAdmin = (await loadSettings(db)).allowedSlackUserIds.has(userId);
		} catch (err) {
			console.error(
				'[auth] loadSettings failed — denying admin to non-superuser:',
				err instanceof Error ? err.message : err,
			);
		}
	}

	// Keep the user token only for admins, and only for as long as they stay
	// admins — the info commands are admin-only, so storing anyone else's would be
	// holding a credential the app has no use for. A non-admin's row is dropped
	// rather than left behind, which also cleans up after someone is removed
	// from the allowed list and logs in again.
	if (isAdmin) {
		try {
			await saveUserToken(db, {
				slackUserId: userId,
				accessToken: tokenData.authed_user.access_token,
				scopes: tokenData.authed_user.scope ?? '',
			});
		} catch (err) {
			// Never blocks the login: the session is the point of this route, and
			// the info commands degrade to "authorize again" on their own.
			console.error(
				'[auth] could not store the user token:',
				err instanceof Error ? err.message : err,
			);
		}
	} else {
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
		{ slackUserId: userId, slackUserName: userName, isAdmin },
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
		`[auth] login: ${userName} (${userId}) admin=${isAdmin}${isSuperuser ? ' (superuser)' : ''}`,
	);
	// Back to the page they asked for — or the dashboard, when they asked for
	// nothing or for something this session may not see.
	redirect(302, resolvePostLoginRedirect(requestedPath, { isAdmin }));
};

/**
 * Display name for the session, read with the **bot** token — it already holds
 * `users:read`, and the user token deliberately carries only `chat:write`.
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

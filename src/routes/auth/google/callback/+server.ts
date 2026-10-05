import { error, redirect, type Cookies } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	OAUTH_REDIRECT_COOKIE,
	resolvePostLoginRedirect,
	sanitizeRedirectTarget,
	withRedirectTo,
} from '$lib/server/post-login-redirect.js';
import { verifyState } from '$lib/server/oauth-state.js';
import {
	exchangeGoogleCode,
	googleDisplayName,
	readIdTokenClaims,
	GOOGLE_PKCE_COOKIE,
	GOOGLE_STATE_COOKIE,
} from '$lib/server/google-signin.js';
import { googleUserId } from '$lib/server/identity.js';
import { googleSignInConfigured } from '$lib/server/env.js';
import { startSession } from '$lib/server/session.js';
import { db } from '$lib/server/db.js';
import { recordGoogleSignIn } from '$lib/server/google-volunteers.js';
import { errMessage } from '$lib/err-message.js';
import { logText } from '$lib/server/log-text.js';

// Sign in with Google: the callback. Shaped like the Slack one on purpose —
// read that file's comments for why each state failure is handled the way it
// is — and simpler, because a Google sign-in has no roles to resolve and no
// token to keep. It always makes a turf-checkout-only session: never an admin,
// never a moderator, whatever the account's email says (FR-011).

export const GET: RequestHandler = async ({ url, cookies }) => {
	if (!googleSignInConfigured()) error(404, 'Not found');

	// Cancel on Google's screen is an answer, not a failure: back to the
	// choice, where they can pick Slack instead or try again — still headed
	// for the page they asked for. The cookie holds it when it survived; a
	// state we signed is the fallback, as below. Re-sanitised either way.
	if (url.searchParams.get('error')) {
		console.log(`[auth] Google sign-in not completed: ${logText(url.searchParams.get('error'))}`);
		const errorState = url.searchParams.get('state');
		const errorVerdict = errorState ? verifyState(errorState) : null;
		const signedDestination = errorVerdict?.ok
			? errorVerdict.state.destination
			: errorVerdict?.reason === 'expired'
				? errorVerdict.destination
				: null;
		const destination = sanitizeRedirectTarget(
			cookies.get(OAUTH_REDIRECT_COOKIE) ?? signedDestination,
		);
		clearFlowCookies(cookies);
		const back = withRedirectTo('/signin', destination);
		redirect(302, `${back}${back.includes('?') ? '&' : '?'}cancelled=1`);
	}

	const code = url.searchParams.get('code');
	const rawState = url.searchParams.get('state');
	if (!code || !rawState) error(400, 'Invalid OAuth state.');

	const verdict = verifyState(rawState);
	if (!verdict.ok) {
		if (verdict.reason === 'bad-signature') {
			console.warn('[auth] Google OAuth state failed signature verification');
			error(400, 'Invalid OAuth state.');
		}
		if (verdict.reason === 'expired' && verdict.purpose !== 'google-login') {
			console.warn('[auth] Slack OAuth state arrived at the Google callback');
			error(400, 'Invalid OAuth state.');
		}
		console.warn(`[auth] restarting Google sign-in: OAuth state ${verdict.reason}`);
		restart(verdict.reason === 'expired' ? verdict.destination : null);
	}
	const state = verdict.state;

	// Signed by us, but for a Slack round trip.
	if (state.purpose !== 'google-login') {
		console.warn('[auth] Slack OAuth state arrived at the Google callback');
		error(400, 'Invalid OAuth state.');
	}

	const storedNonce = cookies.get(GOOGLE_STATE_COOKIE);
	const verifier = cookies.get(GOOGLE_PKCE_COOKIE);
	if (storedNonce === undefined || verifier === undefined) {
		// A login that changed browsers mid-flight: start over in this one,
		// once, still headed where they were going.
		if (!state.isRetry) {
			console.warn('[auth] restarting Google sign-in: no state cookie (browser handoff?)');
			restart(state.destination);
		}
		console.error('[auth] Google sign-in abandoned: state cookie missing after a retry');
		error(
			400,
			'Your browser did not send back the login cookie. This usually means the link was opened ' +
				'inside an app’s built-in browser. Open the site directly in your browser and sign in again.',
		);
	}
	if (storedNonce !== state.nonce) {
		console.warn('[auth] Google OAuth state did not match the cookie');
		error(400, 'Invalid OAuth state.');
	}

	const requestedPath = cookies.get(OAUTH_REDIRECT_COOKIE) ?? state.destination;
	clearFlowCookies(cookies);

	const idToken = await exchangeGoogleCode(code, verifier);
	if (idToken === null) error(502, 'Sign-in failed. Please try again.');

	const claims = readIdTokenClaims(idToken);
	if (!claims.ok) {
		if (claims.reason === 'unverified-email') {
			error(
				403,
				'Google has not verified the email address on this account, so it cannot be used to ' +
					'sign in. Verify it with Google, or sign in with a different account.',
			);
		}
		console.error(`[auth] Google id_token refused: ${claims.reason}`);
		error(502, 'Sign-in failed. Please try again.');
	}

	const { identity } = claims;
	const userId = googleUserId(identity.sub);
	const userName = googleDisplayName(identity);

	// What lets an organizer see who this is and block them if need be
	// (FR-020). Not allowed to cost the volunteer their sign-in: a failed write
	// means admins see no email for them until their next sign-in, which is a
	// smaller problem than a turf map nobody can get into.
	try {
		await recordGoogleSignIn(db, {
			userId,
			email: identity.email,
			displayName: userName,
		});
	} catch (err) {
		console.error('[auth] could not record the Google sign-in:', errMessage(err));
	}

	await startSession(cookies, {
		slackUserId: userId,
		slackUserName: userName,
		isAdmin: false,
		isModerator: false,
		authProvider: 'google',
	});

	// No email in the log: it is the one thing here that identifies a person
	// outside this app, and the id is enough to find the session.
	console.log(`[auth] login (google): ${userName} (${userId})`);
	redirect(
		302,
		resolvePostLoginRedirect(requestedPath, { isAdmin: false, authProvider: 'google' }),
	);
};

function clearFlowCookies(cookies: Cookies): void {
	cookies.delete(GOOGLE_STATE_COOKIE, { path: '/' });
	cookies.delete(GOOGLE_PKCE_COOKIE, { path: '/' });
	cookies.delete(OAUTH_REDIRECT_COOKIE, { path: '/' });
}

/**
 * Start a fresh Google authorization rather than dead-ending on a 400 — the
 * Slack callback's `restart`, for this flow. The code Google just sent is
 * dropped unexchanged, and `retry=1` keeps it to one automatic attempt.
 */
function restart(destination: string | null): never {
	const target = sanitizeRedirectTarget(destination);
	const base = withRedirectTo('/auth/google', target);
	redirect(302, `${base}${base.includes('?') ? '&' : '?'}retry=1`);
}

import { error, redirect, type Cookies } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	OAUTH_REDIRECT_COOKIE,
	sanitizeRedirectTarget,
	withRedirectTo,
} from '$lib/server/post-login-redirect.js';
import { verifyState } from '$lib/server/oauth-state.js';
import {
	appleNameFromUserField,
	exchangeAppleCode,
	readAppleIdTokenClaims,
	APPLE_NONCE_COOKIE,
	APPLE_STATE_COOKIE,
} from '$lib/server/apple-signin.js';
import { appleUserId } from '$lib/server/identity.js';
import { appleSignInConfigured } from '$lib/server/env.js';
import { db } from '$lib/server/db.js';
import { finishOutsideSignIn } from '$lib/server/outside-signin.js';
import { logText } from '$lib/server/log-text.js';

// Sign in with Apple: the callback. The Google callback's twin — read the
// Slack one's comments for why each state failure is handled the way it is —
// with Apple's differences:
//
//   - It is a POST. Apple sends the result as a form post from its own site
//     (response_mode=form_post), which is why this one path is exempt from the
//     cross-site form check in csrf.ts, and why its cookies were set
//     SameSite=None. Every answer is a 303, so the browser follows it with a
//     GET rather than re-posting.
//   - The nonce cookie is checked against the `nonce` inside the id_token,
//     binding the token to the login this browser started.
//   - The name, when there is one, is in the `user` field — sent on the first
//     authorization only.
//
// It always makes a turf-checkout-only session: never an admin, never a
// moderator, whatever the account's email says (FR-013).

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!appleSignInConfigured()) error(404, 'Not found');

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		error(400, 'Invalid OAuth state.');
	}
	const field = (name: string): string | null => {
		const value = form.get(name);
		return typeof value === 'string' && value !== '' ? value : null;
	};

	// Cancel on Apple's screen (`user_cancelled_authorize`) is an answer, not a
	// failure: back to the choice, where they can pick another way in or try
	// again — still headed for the page they asked for.
	//
	// The CSRF exemption means any site can post an `error` here, so this
	// branch only clears the flow's cookies when the post carries this
	// browser's own login: an Apple state we signed whose nonce matches the
	// cookie. Without that match it still answers with the sign-in page, and
	// the destination can only come from a state we signed. Re-sanitised
	// either way.
	//
	// What this does NOT buy is protection for a sign-in in progress. Any page
	// can still disturb one by making the browser start another — a plain
	// link to /auth/apple or /auth/google, or a forged post here with a junk
	// state, which restarts — and the new attempt replaces the flow's cookies
	// and `oauth_redirect`. That is true of every OAuth start route and costs
	// the volunteer one retry; nothing it can do signs anyone in. The check
	// here only keeps a forged cancel from being a quieter way to do the same.
	const appleError = field('error');
	if (appleError) {
		console.log(`[auth] Apple sign-in not completed: ${logText(appleError)}`);
		const errorState = field('state');
		const errorVerdict = errorState ? verifyState(errorState) : null;
		const ours =
			errorVerdict?.ok === true &&
			errorVerdict.state.purpose === 'apple-login' &&
			cookies.get(APPLE_STATE_COOKIE) === errorVerdict.state.nonce;
		const signedDestination = errorVerdict?.ok
			? errorVerdict.state.destination
			: errorVerdict?.reason === 'expired'
				? errorVerdict.destination
				: null;
		const destination = sanitizeRedirectTarget(
			ours ? (cookies.get(OAUTH_REDIRECT_COOKIE) ?? signedDestination) : signedDestination,
		);
		if (ours) clearFlowCookies(cookies);
		const back = withRedirectTo('/signin', destination);
		redirect(303, `${back}${back.includes('?') ? '&' : '?'}cancelled=apple`);
	}

	const code = field('code');
	const rawState = field('state');
	if (!code || !rawState) error(400, 'Invalid OAuth state.');

	const verdict = verifyState(rawState);
	if (!verdict.ok) {
		if (verdict.reason === 'bad-signature') {
			console.warn('[auth] Apple OAuth state failed signature verification');
			error(400, 'Invalid OAuth state.');
		}
		if (verdict.reason === 'expired' && verdict.purpose !== 'apple-login') {
			console.warn('[auth] another sign-in’s OAuth state arrived at the Apple callback');
			error(400, 'Invalid OAuth state.');
		}
		console.warn(`[auth] restarting Apple sign-in: OAuth state ${verdict.reason}`);
		restart(verdict.reason === 'expired' ? verdict.destination : null);
	}
	const state = verdict.state;

	// Signed by us, but for a Slack or Google round trip.
	if (state.purpose !== 'apple-login') {
		console.warn('[auth] another sign-in’s OAuth state arrived at the Apple callback');
		error(400, 'Invalid OAuth state.');
	}

	const storedNonce = cookies.get(APPLE_STATE_COOKIE);
	const tokenNonce = cookies.get(APPLE_NONCE_COOKIE);
	if (storedNonce === undefined || tokenNonce === undefined) {
		// A login that changed browsers mid-flight — or a browser that would
		// not send SameSite=None cookies on Apple's post back: start over in
		// this one, once, still headed where they were going.
		if (!state.isRetry) {
			console.warn('[auth] restarting Apple sign-in: no state cookie (browser handoff?)');
			restart(state.destination);
		}
		console.error('[auth] Apple sign-in abandoned: state cookie missing after a retry');
		error(
			400,
			'Your browser did not send back the login cookie. This usually means the link was opened ' +
				'inside an app’s built-in browser. Open the site directly in your browser and sign in again.',
		);
	}
	if (storedNonce !== state.nonce) {
		console.warn('[auth] Apple OAuth state did not match the cookie');
		error(400, 'Invalid OAuth state.');
	}

	const requestedPath = cookies.get(OAUTH_REDIRECT_COOKIE) ?? state.destination;
	clearFlowCookies(cookies);

	const idToken = await exchangeAppleCode(code);
	if (idToken === null) error(502, 'Sign-in failed. Please try again.');

	const claims = readAppleIdTokenClaims(idToken, tokenNonce);
	if (!claims.ok) {
		if (claims.reason === 'no-email') {
			console.warn('[auth] Apple sign-in refused: no email in the id_token');
			error(
				403,
				'Apple didn’t share an email address for this Apple ID, so it can’t be used to sign in ' +
					'here. Sign in another way, or with a different Apple ID.',
			);
		}
		if (claims.reason === 'unverified-email') {
			error(
				403,
				'Apple has not verified the email address on this Apple ID, so it cannot be used to ' +
					'sign in. Verify it with Apple, or sign in another way.',
			);
		}
		console.error(`[auth] Apple id_token refused: ${claims.reason}`);
		error(502, 'Sign-in failed. Please try again.');
	}

	const { identity } = claims;
	redirect(
		303,
		await finishOutsideSignIn(
			db,
			cookies,
			{
				provider: 'apple',
				userId: appleUserId(identity.sub),
				email: identity.email,
				isPrivateEmail: identity.isPrivateEmail,
				rawName: appleNameFromUserField(field('user')),
			},
			requestedPath,
		),
	);
};

function clearFlowCookies(cookies: Cookies): void {
	cookies.delete(APPLE_STATE_COOKIE, { path: '/' });
	cookies.delete(APPLE_NONCE_COOKIE, { path: '/' });
	cookies.delete(OAUTH_REDIRECT_COOKIE, { path: '/' });
}

/**
 * Start a fresh Apple authorization rather than dead-ending on a 400 — the
 * Slack callback's `restart`, for this flow. The code Apple just sent is
 * dropped unexchanged, and `retry=1` keeps it to one automatic attempt. A 303,
 * so the browser turns Apple's POST into a GET of the start route.
 */
function restart(destination: string | null): never {
	const target = sanitizeRedirectTarget(destination);
	const base = withRedirectTo('/auth/apple', target);
	redirect(303, `${base}${base.includes('?') ? '&' : '?'}retry=1`);
}

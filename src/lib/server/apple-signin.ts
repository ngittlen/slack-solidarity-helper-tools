// Sign in with Apple: the protocol half, with no routing in it.
//
// For volunteers who use turf checkout without joining the Slack, and whose
// account is an Apple ID — see specs/014-apple-sso-login/spec.md. The routes
// under routes/auth/apple/ do the state, cookies and session the way the
// Google ones do; this file only knows how to talk to Apple and how to read
// what comes back. google-signin.ts is its twin, and the differences are
// Apple's:
//
//   - The client secret is not a fixed string but a short-lived ES256 JWT,
//     signed with the private key from the Apple Developer account. It is
//     minted for each exchange, so there is no six-month secret to renew.
//   - Apple does not document PKCE. The `nonce` parameter does the same job:
//     it is echoed inside the id_token, and it has to match the one this
//     browser was given in a cookie.
//   - Asking for name and email makes Apple return by a form POST from its
//     own site rather than a redirect — see setOAuthCookies' crossSiteReturn
//     and the exemption in csrf.ts.
//   - The name is never in the id_token. It comes once, on the first
//     authorization, in a `user` form field beside the code — unsigned, so it
//     is used as a display name and for nothing else.
//
// What we ask for is `name email` and nothing else. The token response is read
// once for its id_token and thrown away; the app never stores an Apple token.
//
// The id_token's signature is NOT verified, for the same reason as Google's:
// it comes straight from Apple's token endpoint over TLS, in answer to a
// request authenticated with our client secret (OpenID Connect Core §3.1.3.7).
// The id_token that also arrives in the form post is a different matter —
// anyone can post that — so it is ignored. The claims are still checked: a
// token for another client, from somewhere else, past its life, or for
// another login attempt (`nonce`) is refused, as is an unverified email.

import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import {
	APPLE_REDIRECT_URI,
	APPLE_SIGNIN_KEY_ID,
	APPLE_SIGNIN_PRIVATE_KEY,
	APPLE_SIGNIN_SERVICES_ID,
	APPLE_SIGNIN_TEAM_ID,
} from './env.js';

const AUTHORIZE_URL = 'https://appleid.apple.com/auth/authorize';
const TOKEN_URL = 'https://appleid.apple.com/auth/token';
const ISSUER = 'https://appleid.apple.com';

/** The state nonce and the id-token nonce, between the start route and the
 *  callback. Not Slack's or Google's cookies, so a login with another
 *  provider started in another tab cannot clobber an Apple one mid-flight. */
export const APPLE_STATE_COOKIE = 'apple_oauth_state';
export const APPLE_NONCE_COOKIE = 'apple_nonce';

/** A fresh nonce for one authorization: 32 random bytes, base64url. */
export function createAppleNonce(): string {
	return randomBytes(32).toString('base64url');
}

export function buildAppleAuthorizeUrl(args: { state: string; nonce: string }): string {
	const params = new URLSearchParams({
		client_id: APPLE_SIGNIN_SERVICES_ID,
		redirect_uri: APPLE_REDIRECT_URI,
		response_type: 'code',
		// Required by Apple whenever name or email is asked for.
		response_mode: 'form_post',
		scope: 'name email',
		state: args.state,
		nonce: args.nonce,
	});
	return `${AUTHORIZE_URL}?${params}`;
}

function base64urlJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * The client secret Apple wants on a token exchange: a JWT signed with the
 * Sign in with Apple key. Five minutes is plenty for the one request it is
 * minted for, and keeps a leaked one from being worth anything.
 *
 * Throws when the key will not parse — a deployment problem the caller turns
 * into "sign-in failed" and a log line.
 */
export function appleClientSecret(now: number = Date.now()): string {
	const iat = Math.floor(now / 1000);
	const header = base64urlJson({ alg: 'ES256', kid: APPLE_SIGNIN_KEY_ID });
	const payload = base64urlJson({
		iss: APPLE_SIGNIN_TEAM_ID,
		iat,
		exp: iat + 300,
		aud: ISSUER,
		sub: APPLE_SIGNIN_SERVICES_ID,
	});
	const signingInput = `${header}.${payload}`;
	// JWS wants the raw r||s pair, not the DER encoding Node defaults to.
	const signature = sign('sha256', Buffer.from(signingInput), {
		key: createPrivateKey(APPLE_SIGNIN_PRIVATE_KEY),
		dsaEncoding: 'ieee-p1363',
	});
	return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * Trade the authorization code for an id_token. Null on any failure — the
 * caller has one thing to say about all of them ("sign-in failed, try again"),
 * and the reason is logged here.
 */
export async function exchangeAppleCode(code: string): Promise<string | null> {
	try {
		const res = await fetch(TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: APPLE_SIGNIN_SERVICES_ID,
				client_secret: appleClientSecret(),
				code,
				grant_type: 'authorization_code',
				redirect_uri: APPLE_REDIRECT_URI,
			}),
		});
		const body = (await res.json()) as { id_token?: unknown; error?: unknown };
		if (!res.ok || typeof body.id_token !== 'string') {
			console.error(`[auth] Apple token exchange failed: ${res.status} ${String(body.error)}`);
			return null;
		}
		return body.id_token;
	} catch (err) {
		console.error('[auth] Apple token exchange failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

export interface AppleIdentity {
	/** Apple's stable account id for this app. Never changes. */
	sub: string;
	/** The real address, or a Hide My Email relay one. */
	email: string;
	isPrivateEmail: boolean;
}

export type AppleIdTokenVerdict =
	| { ok: true; identity: AppleIdentity }
	| {
			ok: false;
			reason:
				| 'malformed'
				| 'wrong-issuer'
				| 'wrong-audience'
				| 'expired'
				| 'wrong-nonce'
				| 'no-email'
				| 'unverified-email';
	  };

/** Apple sends some booleans as the strings "true" / "false". */
function isTrue(value: unknown): boolean {
	return value === true || value === 'true';
}

/** Read and check the claims of an id_token taken from the token endpoint. */
export function readAppleIdTokenClaims(
	idToken: string,
	expectedNonce: string,
	now: number = Date.now(),
): AppleIdTokenVerdict {
	const parts = idToken.split('.');
	if (parts.length !== 3) return { ok: false, reason: 'malformed' };

	let claims: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
		if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'malformed' };
		claims = parsed as Record<string, unknown>;
	} catch {
		return { ok: false, reason: 'malformed' };
	}

	const { iss, aud, exp, sub, email, email_verified, is_private_email, nonce } = claims;
	if (iss !== ISSUER) return { ok: false, reason: 'wrong-issuer' };
	if (aud !== APPLE_SIGNIN_SERVICES_ID) return { ok: false, reason: 'wrong-audience' };
	if (typeof exp !== 'number' || exp * 1000 <= now) return { ok: false, reason: 'expired' };
	if (typeof nonce !== 'string' || nonce === '' || nonce !== expectedNonce) {
		return { ok: false, reason: 'wrong-nonce' };
	}
	if (typeof sub !== 'string' || sub === '') return { ok: false, reason: 'malformed' };
	// Apple leaves the email out for some Apple IDs — school-managed ones, by
	// its own documentation, and reportedly after Hide My Email forwarding is
	// turned off. Refused, with its own reason so the volunteer is told why:
	// without an email organizers have no way to reach or tell apart someone
	// who is not in the Slack (FR-020 of spec 014).
	if (typeof email !== 'string' || email.trim() === '') return { ok: false, reason: 'no-email' };
	if (!isTrue(email_verified)) return { ok: false, reason: 'unverified-email' };

	return { ok: true, identity: { sub, email, isPrivateEmail: isTrue(is_private_email) } };
}

/**
 * The name from the `user` form field Apple posts on the first authorization
 * only: `{"name":{"firstName":"…","lastName":"…"},"email":"…"}`. '' for
 * anything else — absent, hidden by the volunteer, or not what Apple sends.
 * Untidied; the caller runs it through tidyDisplayName like any other name.
 */
export function appleNameFromUserField(raw: string | null): string {
	if (!raw) return '';
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return '';
	}
	const name = (parsed as { name?: unknown } | null)?.name;
	if (typeof name !== 'object' || name === null) return '';
	const { firstName, lastName } = name as { firstName?: unknown; lastName?: unknown };
	return [firstName, lastName].filter((p): p is string => typeof p === 'string').join(' ');
}

// Sign in with Google: the protocol half, with no routing in it.
//
// For volunteers who use turf checkout without joining the Slack — see
// specs/013-google-sso-login/spec.md. The routes under routes/auth/google/ do
// the state, cookies and session the same way the Slack ones do; this file only
// knows how to talk to Google and how to read what comes back.
//
// What we ask for is identity and nothing else: `openid email profile`. No
// Gmail, no Drive, no offline access. The token response is read once for its
// id_token and thrown away — the app never stores a Google token, because a
// session is all a sign-in needs.
//
// The id_token's signature is NOT verified, deliberately. It comes straight
// from Google's token endpoint over TLS, in answer to a request authenticated
// with our client secret, and OpenID Connect Core §3.1.3.7 allows the client
// to use TLS server validation in place of checking the signature in exactly
// that case. Doing it anyway would mean fetching and caching Google's JWKS for
// no gain in what the token can be trusted for. The claims below are still
// checked: a token for another client (`aud`), from somewhere else (`iss`) or
// past its life (`exp`) is refused, as is an email Google does not vouch for.

import { createHash, randomBytes } from 'node:crypto';
import { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_REDIRECT_URI } from './env.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/** The state nonce and PKCE verifier, between the start route and the
 *  callback. Not Slack's `oauth_state`, so a Slack login started in another
 *  tab cannot clobber a Google one mid-flight. */
export const GOOGLE_STATE_COOKIE = 'google_oauth_state';
export const GOOGLE_PKCE_COOKIE = 'google_pkce';

/** PKCE: the verifier stays in a cookie, the challenge goes to Google. */
export function createPkcePair(): { verifier: string; challenge: string } {
	// 32 random bytes is 43 base64url characters, the minimum RFC 7636 allows.
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

export function buildGoogleAuthorizeUrl(args: { state: string; codeChallenge: string }): string {
	const params = new URLSearchParams({
		client_id: GOOGLE_OAUTH_CLIENT_ID,
		redirect_uri: GOOGLE_REDIRECT_URI,
		response_type: 'code',
		scope: 'openid email profile',
		state: args.state,
		code_challenge: args.codeChallenge,
		code_challenge_method: 'S256',
		// Always show the account chooser. Someone signed in to a work account
		// in this browser should get to pick the one they volunteer with,
		// rather than being signed in as whichever Google remembered.
		prompt: 'select_account',
	});
	return `${AUTHORIZE_URL}?${params}`;
}

/**
 * Trade the authorization code for an id_token. Null on any failure — the
 * caller has one thing to say about all of them ("sign-in failed, try again"),
 * and the reason is logged here.
 */
export async function exchangeGoogleCode(code: string, verifier: string): Promise<string | null> {
	try {
		const res = await fetch(TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: GOOGLE_OAUTH_CLIENT_ID,
				client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
				code,
				code_verifier: verifier,
				grant_type: 'authorization_code',
				redirect_uri: GOOGLE_REDIRECT_URI,
			}),
		});
		const body = (await res.json()) as { id_token?: unknown; error?: unknown };
		if (!res.ok || typeof body.id_token !== 'string') {
			console.error(`[auth] Google token exchange failed: ${res.status} ${String(body.error)}`);
			return null;
		}
		return body.id_token;
	} catch (err) {
		console.error('[auth] Google token exchange failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

export interface GoogleIdentity {
	/** Google's stable account id. Never changes, unlike the email. */
	sub: string;
	email: string;
	/** Profile name, or '' when the account has none. */
	name: string;
}

export type IdTokenVerdict =
	| { ok: true; identity: GoogleIdentity }
	| {
			ok: false;
			reason: 'malformed' | 'wrong-issuer' | 'wrong-audience' | 'expired' | 'unverified-email';
	  };

/** Read and check the claims of an id_token taken from the token endpoint. */
export function readIdTokenClaims(idToken: string, now: number = Date.now()): IdTokenVerdict {
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

	const { iss, aud, exp, sub, email, email_verified, name } = claims;
	if (typeof iss !== 'string' || !ISSUERS.has(iss)) return { ok: false, reason: 'wrong-issuer' };
	if (aud !== GOOGLE_OAUTH_CLIENT_ID) return { ok: false, reason: 'wrong-audience' };
	if (typeof exp !== 'number' || exp * 1000 <= now) return { ok: false, reason: 'expired' };
	if (typeof sub !== 'string' || sub === '' || typeof email !== 'string' || email === '') {
		return { ok: false, reason: 'malformed' };
	}
	// Google sends a boolean; very old tokens sent the string. Anything else,
	// including absent, is "not vouched for".
	if (email_verified !== true && email_verified !== 'true') {
		return { ok: false, reason: 'unverified-email' };
	}

	return {
		ok: true,
		identity: { sub, email, name: typeof name === 'string' ? name.trim() : '' },
	};
}

/** Longest display name kept. Generous for a real name; short enough that a
 *  profile name cannot fill a Slack message or a spreadsheet cell. */
export const MAX_DISPLAY_NAME = 64;

/** What a Google volunteer is called when their profile has no usable name. */
export const NAMELESS_VOLUNTEER = 'Google volunteer';

/**
 * Everything invisible, by Unicode category rather than a hand-kept list:
 * control characters (Cc), format characters (Cf: bidi controls, zero-width
 * characters, the soft hyphen, tag characters), and line and paragraph
 * separators. Plus the characters that are not in those categories but still
 * draw nothing: the Hangul fillers, the braille blank and the variation
 * selectors. None belongs in a name, and the bidi ones can make a name read
 * differently from what it is.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Variation_Selector}\u115f\u1160\u3164\u2800]/gu;

/** The characters Slack mrkdwn formats with. Escaping `& < >` cannot stop
 *  them, and a real name does not need them. */
const SLACK_FORMATTING = /[*_~`]/g;

/**
 * Something Slack might auto-link: a scheme, a domain in any script, or an
 * IPv4 address. Deliberately broad: a real name rarely has a dot with no space
 * after it, and one that does only gains a `\u00b7`.
 */
const LOOKS_LIKE_LINK = /:\/\/|[\p{L}\p{N}-]+\.\p{L}{2,}|\d{1,3}(?:\.\d{1,3}){3}/u;

/**
 * What the app calls a Google volunteer. It labels the session and is the
 * holder name stamped on their claims — and from there it reaches Slack posts
 * and the campaign's spreadsheets. Any stranger with a Google account chooses
 * it, so it is tidied here, once:
 *
 *   - Invisible and control characters (newlines included) become spaces and
 *     whitespace collapses, so a name is always one plain line.
 *   - Slack's formatting characters are dropped, and anything Slack would turn
 *     into a live link is defanged (`https://evil.example` →
 *     `https evil·example`), so the bot never posts a link a volunteer chose.
 *   - It is capped at MAX_DISPLAY_NAME characters — counted by code point, so
 *     the cut never splits one in half.
 *
 * The Slack sinks still escape `& < >` themselves; this is the part escaping
 * cannot do.
 *
 * Without a usable name it is NAMELESS_VOLUNTEER — never part of the email,
 * which would put an identifier for them into Slack and the spreadsheets that
 * the privacy policy says the email never reaches.
 */
export function googleDisplayName(identity: Pick<GoogleIdentity, 'name'>): string {
	let tidy = identity.name.replace(INVISIBLE, ' ').replace(SLACK_FORMATTING, ' ');
	if (LOOKS_LIKE_LINK.test(tidy)) tidy = tidy.replace(/:\/\//g, ' ').replace(/\./g, '·');
	tidy = tidy.replace(/\s+/g, ' ').trim();
	tidy = Array.from(tidy).slice(0, MAX_DISPLAY_NAME).join('').trim();
	return tidy || NAMELESS_VOLUNTEER;
}

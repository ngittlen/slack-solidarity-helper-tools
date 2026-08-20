// Signed OAuth `state` for the Slack login round trip.
//
// The state used to be a bare UUID whose only job was to match a cookie. That
// works right up until the browser that *finishes* a login is not the browser
// that *started* it — the everyday case being a link tapped in Slack's in-app
// webview and then reopened in Safari, which carries the URL across intact but
// not the cookie jar. The callback then saw a state it could not verify at all
// and had no choice but to 400, stranding someone who did nothing wrong.
//
// Signing the state fixes that: everything the callback needs to make a
// decision rides in the URL, authenticated with an HMAC so none of it is
// meaningfully attacker-supplied. The nonce must still match the cookie for a
// login to succeed — that is the CSRF guard and nothing here weakens it — but
// when the cookie is *absent* the callback can now tell a lost jar apart from an
// attack, and it knows where the person was originally headed so the retry can
// resume the journey instead of dumping them on the dashboard.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { SLACK_CLIENT_SECRET } from './env.js';

/** How long a login attempt may sit on Slack's approval screen. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Destination cap for the *signed* copy specifically, well under the 512 the
 * cookie allows. The state is a query parameter on the URL we hand to Slack,
 * and a destination that long would be a pathological one anyway — the cookie
 * still carries it in full for logins that finish in the browser they started
 * in, which is the only case a destination that long can survive regardless.
 */
const MAX_STATE_DESTINATION = 256;

export interface OAuthState {
	/** Random per-attempt value, mirrored into the `oauth_state` cookie. */
	nonce: string;
	/** Where the person was headed, or null. Re-sanitised by the callback. */
	destination: string | null;
	/** Epoch ms, for the TTL. */
	issuedAt: number;
	/** True when this attempt *is* the one automatic retry — see the callback. */
	isRetry: boolean;
}

export type StateVerdict =
	| { ok: true; state: OAuthState }
	| { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

/**
 * Keyed off the OAuth client secret rather than a new environment variable: it
 * is already required at startup, already scoped to precisely this flow, and
 * rotating it invalidates nothing but logins that are mid-flight. Run through
 * HMAC with a label so the key here is not literally the client secret, and so
 * a future second use of the same secret gets a key unrelated to this one.
 */
function signingKey(): Buffer {
	return createHmac('sha256', SLACK_CLIENT_SECRET).update('oauth-state-v1').digest();
}

function sign(encodedPayload: string): string {
	return createHmac('sha256', signingKey()).update(encodedPayload).digest('base64url');
}

/** Mint a state for a fresh authorization attempt, plus the nonce to cookie. */
export function signState(opts: { destination: string | null; isRetry: boolean }): {
	state: string;
	nonce: string;
} {
	const nonce = randomUUID();
	const destination =
		opts.destination !== null && opts.destination.length <= MAX_STATE_DESTINATION
			? opts.destination
			: null;

	const encoded = Buffer.from(
		JSON.stringify({ n: nonce, d: destination, t: Date.now(), r: opts.isRetry }),
		'utf8',
	).toString('base64url');

	return { state: `${encoded}.${sign(encoded)}`, nonce };
}

/**
 * Check a state that came back from Slack.
 *
 * The three failure reasons are deliberately distinct, because the callback
 * treats them very differently: `bad-signature` is the only one that means
 * somebody is playing games, and it is the only one that gets a flat refusal.
 */
export function verifyState(raw: string): StateVerdict {
	const dot = raw.indexOf('.');
	// Not our format at all — which is exactly what a state minted by the old
	// bare-UUID code looks like, so this is also the deploy-window path.
	if (dot <= 0 || raw.indexOf('.', dot + 1) !== -1) return { ok: false, reason: 'malformed' };

	const encoded = raw.slice(0, dot);
	const provided = Buffer.from(raw.slice(dot + 1), 'utf8');
	const expected = Buffer.from(sign(encoded), 'utf8');

	// timingSafeEqual throws on ragged input, and the expected value is the
	// base64url of a fixed-size digest, so a length mismatch is already a no.
	if (provided.length !== expected.length) return { ok: false, reason: 'bad-signature' };
	if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'bad-signature' };

	// Past this line the payload is one we minted, so the parsing below is
	// belt-and-braces rather than untrusted-input handling.
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'malformed' };

	const { n, d, t, r } = parsed as Record<string, unknown>;
	if (typeof n !== 'string' || n === '' || typeof t !== 'number' || !Number.isFinite(t)) {
		return { ok: false, reason: 'malformed' };
	}
	if (Date.now() - t > STATE_TTL_MS) return { ok: false, reason: 'expired' };

	return {
		ok: true,
		state: {
			nonce: n,
			destination: typeof d === 'string' ? d : null,
			issuedAt: t,
			isRetry: r === true,
		},
	};
}

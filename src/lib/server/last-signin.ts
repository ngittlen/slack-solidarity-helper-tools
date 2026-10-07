// The "Last used" mark on /signin: which way this browser last signed in.
// Set by startSession (session.ts), read by routes/signin.

export type SignInMethod = 'slack' | 'google' | 'apple';

/**
 * Which way this browser last signed in, so /signin can mark that button
 * "Last used" — three buttons, and a volunteer who signed in with Apple last
 * week should not have to remember which. Holds that one word and nothing
 * else, is set on every sign-in, and outlives sign-out on purpose: the next
 * visit to /signin is exactly when it is needed.
 */
export const LAST_SIGNIN_COOKIE = 'last_signin';

/** A year. Long enough to span the campaign; the session itself is 8 hours. */
export const LAST_SIGNIN_MAX_AGE = 365 * 24 * 60 * 60;

/** The cookie's value, if it is one of the methods. Anything else is ignored. */
export function parseLastSignIn(raw: string | undefined): SignInMethod | null {
	return raw === 'slack' || raw === 'google' || raw === 'apple' ? raw : null;
}

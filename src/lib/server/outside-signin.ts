// The last step of a Google or Apple sign-in, once its callback has decided
// who someone is: record them, settle their name, start the session.
//
// One function rather than a copy in each callback, for the same reason
// session.ts exists — so the two providers cannot drift apart in what a
// session holds, what gets logged, or where the volunteer lands. Each callback
// keeps the part that really differs: talking to its provider.

import type { Cookies } from '@sveltejs/kit';
import type { drizzle } from 'drizzle-orm/libsql';
import { resolvePostLoginRedirect } from './post-login-redirect.js';
import { recordOutsideSignIn } from './outside-volunteers.js';
import { startSession } from './session.js';
import { tidyDisplayName } from './display-name.js';
import type { OutsideProvider } from './identity.js';
import { errMessage } from '../err-message.js';

type Database = ReturnType<typeof drizzle>;

/** What an unnamed volunteer's session carries in place of a name. Spec 013's
 *  word for a nameless Google volunteer, so older code reads it as it did. */
const UNNAMED_PLACEHOLDER: Record<OutsideProvider, string> = {
	google: 'Google volunteer',
	apple: 'Apple volunteer',
};

export interface OutsideIdentity {
	provider: OutsideProvider;
	/** The holder id, `google:<sub>` or `apple:<sub>`. */
	userId: string;
	email: string;
	isPrivateEmail: boolean;
	/** The name the provider sent, untidied, or '' when it sent none. */
	rawName: string;
}

/**
 * Record the sign-in, start an eight-hour turf-only session, and return where
 * to send the volunteer. Never an admin, never a moderator, whatever the
 * account's email says.
 *
 * The name is the provider's, tidied; else the one already stored — typed on
 * /turfs, or Apple's from an earlier sign-in; else none, and the session is
 * marked `needsName` so /turfs asks for one before the first claim.
 */
export async function finishOutsideSignIn(
	db: Database,
	cookies: Cookies,
	identity: OutsideIdentity,
	requestedPath: string | null,
): Promise<string> {
	const offered = tidyDisplayName(identity.rawName) || null;

	// What lets an organizer see who this is and block them if need be. Not
	// allowed to cost the volunteer their sign-in: a failed write means admins
	// see no email for them until their next sign-in, which is a smaller
	// problem than a turf map nobody can get into. Without the stored name to
	// fall back on, the offered one is all there is.
	let name = offered;
	try {
		name = await recordOutsideSignIn(db, {
			userId: identity.userId,
			provider: identity.provider,
			email: identity.email,
			isPrivateEmail: identity.isPrivateEmail,
			displayName: offered,
		});
	} catch (err) {
		console.error(`[auth] could not record the ${identity.provider} sign-in:`, errMessage(err));
	}

	await startSession(cookies, {
		slackUserId: identity.userId,
		// Never stamped on a claim while `needsName` is set — this code refuses
		// the claim. The placeholder is for the code before it, which knows
		// nothing of `needsName`: a machine still running it during a deploy, or
		// after a rollback, stamps spec 013's placeholder rather than an empty
		// holder name in the turf log, Slack and the sheets.
		slackUserName: name ?? UNNAMED_PLACEHOLDER[identity.provider],
		isAdmin: false,
		isModerator: false,
		authProvider: identity.provider,
		...(name === null ? { needsName: true as const } : {}),
	});

	// No email in the log: it is the one thing here that identifies a person
	// outside this app, and the id is enough to find the session.
	console.log(
		`[auth] login (${identity.provider}): ${name ?? '(no name yet)'} (${identity.userId})`,
	);
	return resolvePostLoginRedirect(requestedPath, {
		isAdmin: false,
		authProvider: identity.provider,
	});
}

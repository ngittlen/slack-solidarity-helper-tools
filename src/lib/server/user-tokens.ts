// Storage and retrieval of the per-user Slack tokens that let the
// admin-defined info commands post as a real person instead of as the bot.
//
// Tokens are captured during the normal OAuth login (auth/slack/callback) and
// written encrypted — see token-crypto.ts. Nothing here ever logs or returns a
// token to a caller that did not ask for it by user id.

import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';

import { slackUserTokens } from './schema.js';
import { TOKEN_ENCRYPTION_KEY } from './env.js';
import { decryptToken, encryptToken } from './token-crypto.js';
import { errMessage } from '../err-message.js';

type Db = ReturnType<typeof drizzle>;

/** The user scope that permits posting as the authorizing user. */
export const POST_AS_USER_SCOPE = 'chat:write';

const LOG = '[info-command]';

/** Slack returns `authed_user.scope` as a comma-separated list. */
export function hasScope(scopes: string, scope: string): boolean {
	return scopes
		.split(',')
		.map((s) => s.trim())
		.includes(scope);
}

export async function saveUserToken(
	db: Db,
	args: { slackUserId: string; accessToken: string; scopes: string },
): Promise<void> {
	const encryptedToken = encryptToken(args.accessToken, TOKEN_ENCRYPTION_KEY);
	const updatedAt = new Date().toISOString();
	await db
		.insert(slackUserTokens)
		.values({ slackUserId: args.slackUserId, encryptedToken, scopes: args.scopes, updatedAt })
		// Re-authorizing replaces the old token rather than accumulating rows;
		// Slack issues a new one on every install and the previous one may already
		// have been revoked.
		.onConflictDoUpdate({
			target: slackUserTokens.slackUserId,
			set: { encryptedToken, scopes: args.scopes, updatedAt },
		});
}

export async function deleteUserToken(db: Db, slackUserId: string): Promise<void> {
	await db.delete(slackUserTokens).where(eq(slackUserTokens.slackUserId, slackUserId));
}

/**
 * Why a lookup failed. All four failure modes are fixed by the same action —
 * re-authorize — but they are kept apart so the logs say which one happened.
 *
 *   missing     — no row; this person has never logged in since the feature landed
 *   stale-scope — a row from before `chat:write` was requested
 *   unreadable  — decryption failed (rotated key, tampered or truncated row)
 *   error       — the database read itself failed
 */
export type TokenLookupFailure = 'missing' | 'stale-scope' | 'unreadable' | 'error';

export type TokenLookup = { ok: true; token: string } | { ok: false; reason: TokenLookupFailure };

export async function loadUserToken(db: Db, slackUserId: string): Promise<TokenLookup> {
	let rows;
	try {
		rows = await db
			.select({ encryptedToken: slackUserTokens.encryptedToken, scopes: slackUserTokens.scopes })
			.from(slackUserTokens)
			.where(eq(slackUserTokens.slackUserId, slackUserId));
	} catch (err) {
		console.error(`${LOG} token lookup failed for ${slackUserId}:`, errMessage(err));
		return { ok: false, reason: 'error' };
	}

	const row = rows[0];
	if (!row) return { ok: false, reason: 'missing' };

	// Checked before decrypting: a token granted when only `identity.basic` was
	// requested is real and decryptable, it just can't post. Slack would reject
	// it with `missing_scope`, which is a worse error to show than "authorize
	// again".
	if (!hasScope(row.scopes, POST_AS_USER_SCOPE)) {
		return { ok: false, reason: 'stale-scope' };
	}

	try {
		return { ok: true, token: decryptToken(row.encryptedToken, TOKEN_ENCRYPTION_KEY) };
	} catch (err) {
		console.error(`${LOG} stored token for ${slackUserId} is unreadable:`, errMessage(err));
		return { ok: false, reason: 'unreadable' };
	}
}

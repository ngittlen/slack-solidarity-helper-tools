// Authenticated encryption for the per-user Slack tokens in `slack_user_tokens`.
//
// These are `xoxp-` tokens that can post as a real person, so they are the one
// thing in this database that is worth encrypting on its own: a Turso dump, a
// stray backup, or a read-only replica leak should yield ciphertext rather than
// a set of working credentials. The key lives in TOKEN_ENCRYPTION_KEY, which is
// held by fly.io and never written to the database.
//
// AES-256-GCM rather than plain CBC/CTR because GCM authenticates as well as
// encrypts: a tampered row fails to decrypt instead of handing back bytes that
// were quietly altered. Every call generates a fresh random IV — reusing an IV
// under one key is the one mistake that actually breaks GCM.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const TAG_BYTES = 16;

/** Wire format: base64(iv ‖ authTag ‖ ciphertext). */
const encode = (iv: Buffer, tag: Buffer, ct: Buffer) =>
	Buffer.concat([iv, tag, ct]).toString('base64');

export class TokenCryptoError extends Error {}

/**
 * Decode and validate a base64 key.
 *
 * Exported so `validateEnv()` can fail at startup on a truncated or mistyped
 * key, rather than at the moment someone first tries to post — by which point
 * the failure looks like a Slack problem instead of a config one.
 */
export function parseEncryptionKey(base64Key: string): Buffer {
	if (!base64Key) {
		throw new TokenCryptoError('TOKEN_ENCRYPTION_KEY is not set');
	}
	let key: Buffer;
	try {
		key = Buffer.from(base64Key, 'base64');
	} catch {
		throw new TokenCryptoError('TOKEN_ENCRYPTION_KEY is not valid base64');
	}
	// Buffer.from is lenient — it drops invalid characters rather than throwing —
	// so the length check is what actually catches a malformed value.
	if (key.length !== KEY_BYTES) {
		throw new TokenCryptoError(
			`TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
				`Generate one with: openssl rand -base64 32`,
		);
	}
	return key;
}

export function encryptToken(plaintext: string, base64Key: string): string {
	const key = parseEncryptionKey(base64Key);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return encode(iv, cipher.getAuthTag(), ct);
}

/**
 * Throws `TokenCryptoError` on a bad key, a truncated row, or a tampered one —
 * all three are indistinguishable to GCM and all three mean the same thing to
 * the caller: this token is unusable, make the user re-authorize.
 */
export function decryptToken(encoded: string, base64Key: string): string {
	const key = parseEncryptionKey(base64Key);

	const raw = Buffer.from(encoded, 'base64');
	if (raw.length <= IV_BYTES + TAG_BYTES) {
		throw new TokenCryptoError('stored token is truncated or not in the expected format');
	}

	const iv = raw.subarray(0, IV_BYTES);
	const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
	const ct = raw.subarray(IV_BYTES + TAG_BYTES);

	try {
		const decipher = createDecipheriv(ALGORITHM, key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
	} catch {
		// Deliberately opaque: the underlying message ("Unsupported state or unable
		// to authenticate data") tells an operator nothing and tells an attacker
		// which half of the check failed.
		throw new TokenCryptoError('stored token could not be decrypted');
	}
}

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
	encryptToken,
	decryptToken,
	parseEncryptionKey,
	TokenCryptoError,
} from './token-crypto.js';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

describe('parseEncryptionKey', () => {
	it('accepts a 32-byte base64 key', () => {
		expect(parseEncryptionKey(KEY)).toHaveLength(32);
	});

	it('rejects an empty key', () => {
		expect(() => parseEncryptionKey('')).toThrow(TokenCryptoError);
	});

	it('rejects a key of the wrong length', () => {
		expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow(
			/must decode to 32 bytes, got 16/,
		);
	});

	it('rejects a non-base64 key rather than silently truncating it', () => {
		// Buffer.from drops invalid characters instead of throwing, so "!!!!" would
		// decode to zero bytes — the length check is what catches it.
		expect(() => parseEncryptionKey('!!!!')).toThrow(TokenCryptoError);
	});
});

describe('encryptToken / decryptToken', () => {
	it('round-trips a token', () => {
		const token = 'xoxp-1234-5678-abcdef';
		expect(decryptToken(encryptToken(token, KEY), KEY)).toBe(token);
	});

	it('round-trips non-ASCII text', () => {
		const value = 'solidarité 🧰 — ünïcode';
		expect(decryptToken(encryptToken(value, KEY), KEY)).toBe(value);
	});

	it('produces different ciphertext each time for the same input', () => {
		// A fixed IV would make identical tokens produce identical rows, leaking
		// which users share a value and breaking GCM's security guarantee.
		const a = encryptToken('xoxp-same', KEY);
		const b = encryptToken('xoxp-same', KEY);
		expect(a).not.toBe(b);
		expect(decryptToken(a, KEY)).toBe(decryptToken(b, KEY));
	});

	it('does not leak the plaintext into the encoded output', () => {
		const encoded = encryptToken('xoxp-secret-value', KEY);
		expect(Buffer.from(encoded, 'base64').toString('utf8')).not.toContain('xoxp-secret-value');
	});

	it('fails to decrypt with the wrong key', () => {
		expect(() => decryptToken(encryptToken('xoxp-abc', KEY), OTHER_KEY)).toThrow(
			/could not be decrypted/,
		);
	});

	it('rejects a tampered ciphertext', () => {
		const raw = Buffer.from(encryptToken('xoxp-abc', KEY), 'base64');
		raw[raw.length - 1] ^= 0xff;
		expect(() => decryptToken(raw.toString('base64'), KEY)).toThrow(/could not be decrypted/);
	});

	it('rejects a tampered auth tag', () => {
		const raw = Buffer.from(encryptToken('xoxp-abc', KEY), 'base64');
		raw[12] ^= 0xff; // first byte of the tag
		expect(() => decryptToken(raw.toString('base64'), KEY)).toThrow(/could not be decrypted/);
	});

	it('rejects a value too short to contain an IV and tag', () => {
		expect(() => decryptToken(Buffer.alloc(20).toString('base64'), KEY)).toThrow(
			/truncated or not in the expected format/,
		);
	});
});

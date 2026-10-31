import { verify } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A real P-256 key, as the `.p8` from Apple is, so the client secret is
// signed and checked for real.
const keys = vi.hoisted(() => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before imports
	const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto');
	return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
});

vi.mock('$lib/server/env', () => ({
	APPLE_SIGNIN_SERVICES_ID: 'org.example.turfs',
	APPLE_SIGNIN_TEAM_ID: 'TEAM123456',
	APPLE_SIGNIN_KEY_ID: 'KEY1234567',
	APPLE_SIGNIN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
	APPLE_REDIRECT_URI: 'https://app.example/auth/apple/callback',
}));

import {
	appleClientSecret,
	appleNameFromUserField,
	buildAppleAuthorizeUrl,
	createAppleNonce,
	exchangeAppleCode,
	readAppleIdTokenClaims,
} from './apple-signin.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');

/** An unsigned JWT with these claims — signatures are not checked, by design. */
function idToken(overrides: Record<string, unknown> = {}): string {
	const claims = {
		iss: 'https://appleid.apple.com',
		aud: 'org.example.turfs',
		exp: NOW / 1000 + 600,
		sub: '001234.abcdef.0987',
		email: 'x1y2@privaterelay.appleid.com',
		email_verified: 'true',
		is_private_email: 'true',
		nonce: 'NONCE',
		...overrides,
	};
	const part = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
	return `${part({ alg: 'RS256' })}.${part(claims)}.sig`;
}

function decode(part: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('createAppleNonce', () => {
	it('is 32 random bytes, fresh every time', () => {
		expect(createAppleNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(createAppleNonce()).not.toBe(createAppleNonce());
	});
});

describe('buildAppleAuthorizeUrl', () => {
	it('asks for name and email only, returned by form post', () => {
		const url = new URL(buildAppleAuthorizeUrl({ state: 'S', nonce: 'N' }));
		expect(url.origin + url.pathname).toBe('https://appleid.apple.com/auth/authorize');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: 'org.example.turfs',
			redirect_uri: 'https://app.example/auth/apple/callback',
			response_type: 'code',
			response_mode: 'form_post',
			scope: 'name email',
			state: 'S',
			nonce: 'N',
		});
	});
});

describe('appleClientSecret', () => {
	it('is an ES256 JWT for this team and Services ID, valid for five minutes', () => {
		const [header, payload] = appleClientSecret(NOW).split('.');
		expect(decode(header!)).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
		expect(decode(payload!)).toEqual({
			iss: 'TEAM123456',
			iat: NOW / 1000,
			exp: NOW / 1000 + 300,
			aud: 'https://appleid.apple.com',
			sub: 'org.example.turfs',
		});
	});

	it('is signed with the private key, in the raw form JWS uses', () => {
		const [header, payload, signature] = appleClientSecret(NOW).split('.');
		const ok = verify(
			'sha256',
			Buffer.from(`${header}.${payload}`),
			{ key: keys.publicKey, dsaEncoding: 'ieee-p1363' },
			Buffer.from(signature!, 'base64url'),
		);
		expect(ok).toBe(true);
		// r||s for P-256 is exactly 64 bytes; DER would be ~70 and vary.
		expect(Buffer.from(signature!, 'base64url')).toHaveLength(64);
	});
});

describe('readAppleIdTokenClaims', () => {
	it('returns the identity from a good token, relay address and all', () => {
		expect(readAppleIdTokenClaims(idToken(), 'NONCE', NOW)).toEqual({
			ok: true,
			identity: {
				sub: '001234.abcdef.0987',
				email: 'x1y2@privaterelay.appleid.com',
				isPrivateEmail: true,
			},
		});
	});

	it('accepts boolean claims as well as Apple’s strings', () => {
		const verdict = readAppleIdTokenClaims(
			idToken({ email_verified: true, is_private_email: false, email: 'ana@example.com' }),
			'NONCE',
			NOW,
		);
		expect(verdict).toEqual({
			ok: true,
			identity: { sub: '001234.abcdef.0987', email: 'ana@example.com', isPrivateEmail: false },
		});
	});

	it('reads a missing is_private_email as a real address', () => {
		const verdict = readAppleIdTokenClaims(idToken({ is_private_email: undefined }), 'NONCE', NOW);
		expect(verdict.ok && verdict.identity.isPrivateEmail).toBe(false);
	});

	it.each([
		['wrong-issuer', { iss: 'https://accounts.google.com' }],
		['wrong-audience', { aud: 'org.someone.else' }],
		['expired', { exp: NOW / 1000 - 1 }],
		['wrong-nonce', { nonce: 'OTHER' }],
		['wrong-nonce', { nonce: undefined }],
		['unverified-email', { email_verified: 'false' }],
		['unverified-email', { email_verified: undefined }],
		['malformed', { sub: '' }],
		['no-email', { email: undefined }],
		['no-email', { email: '' }],
		['no-email', { email: undefined, email_verified: undefined }],
	])('refuses with %s', (reason, overrides) => {
		expect(readAppleIdTokenClaims(idToken(overrides), 'NONCE', NOW)).toEqual({ ok: false, reason });
	});

	it('refuses an empty expected nonce, so a missing cookie can never match', () => {
		expect(readAppleIdTokenClaims(idToken({ nonce: '' }), '', NOW)).toEqual({
			ok: false,
			reason: 'wrong-nonce',
		});
	});

	it('refuses a token that is not three parts, or whose payload is not JSON', () => {
		expect(readAppleIdTokenClaims('nope', 'NONCE', NOW)).toEqual({
			ok: false,
			reason: 'malformed',
		});
		expect(readAppleIdTokenClaims('a.%%%.c', 'NONCE', NOW)).toEqual({
			ok: false,
			reason: 'malformed',
		});
	});
});

describe('appleNameFromUserField', () => {
	it('joins first and last name', () => {
		expect(
			appleNameFromUserField(
				JSON.stringify({ name: { firstName: 'Ana', lastName: 'Ruiz' }, email: 'a@x.org' }),
			),
		).toBe('Ana Ruiz');
	});

	it('copes with only one part', () => {
		expect(appleNameFromUserField(JSON.stringify({ name: { firstName: 'Ana' } }))).toBe('Ana');
	});

	it.each([[null], [''], ['not json'], ['null'], ['{"email":"a@x.org"}'], ['{"name":"Ana"}']])(
		'is empty for %j',
		(raw) => {
			expect(appleNameFromUserField(raw)).toBe('');
		},
	);
});

describe('exchangeAppleCode', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock);
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		fetchMock.mockReset();
	});

	it('posts the code with a freshly minted client secret and returns the id_token', async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id_token: 'T' }) });

		expect(await exchangeAppleCode('CODE')).toBe('T');
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://appleid.apple.com/auth/token');
		const body = Object.fromEntries(init.body as URLSearchParams);
		expect(body).toMatchObject({
			client_id: 'org.example.turfs',
			code: 'CODE',
			grant_type: 'authorization_code',
			redirect_uri: 'https://app.example/auth/apple/callback',
		});
		expect(body.client_secret!.split('.')).toHaveLength(3);
	});

	it('returns null when Apple refuses', async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 400,
			json: async () => ({ error: 'invalid_grant' }),
		});
		expect(await exchangeAppleCode('CODE')).toBeNull();
	});

	it('returns null when the request throws', async () => {
		fetchMock.mockRejectedValue(new Error('network down'));
		expect(await exchangeAppleCode('CODE')).toBeNull();
	});
});

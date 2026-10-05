import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/server/env', () => ({
	GOOGLE_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
	GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
	GOOGLE_REDIRECT_URI: 'http://localhost/auth/google/callback',
}));

import {
	buildGoogleAuthorizeUrl,
	createPkcePair,
	exchangeGoogleCode,
	googleDisplayName,
	MAX_DISPLAY_NAME,
	NAMELESS_VOLUNTEER,
	readIdTokenClaims,
} from './google-signin.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');

/** An unsigned JWT with these claims — signatures are not checked, by design. */
function idToken(overrides: Record<string, unknown> = {}): string {
	const claims = {
		iss: 'https://accounts.google.com',
		aud: 'client-id.apps.googleusercontent.com',
		exp: NOW / 1000 + 3600,
		sub: '1093',
		email: 'ana@example.com',
		email_verified: true,
		name: 'Ana Ruiz',
		...overrides,
	};
	const part = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
	return `${part({ alg: 'RS256' })}.${part(claims)}.sig`;
}

describe('createPkcePair', () => {
	it('derives the challenge from the verifier with S256', () => {
		const { verifier, challenge } = createPkcePair();
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
	});

	it('is fresh every time', () => {
		expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
	});
});

describe('buildGoogleAuthorizeUrl', () => {
	it('asks for identity only, with PKCE and the account chooser', () => {
		const url = new URL(buildGoogleAuthorizeUrl({ state: 'S', codeChallenge: 'C' }));
		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: 'client-id.apps.googleusercontent.com',
			redirect_uri: 'http://localhost/auth/google/callback',
			response_type: 'code',
			scope: 'openid email profile',
			state: 'S',
			code_challenge: 'C',
			code_challenge_method: 'S256',
			prompt: 'select_account',
		});
	});
});

describe('readIdTokenClaims', () => {
	it('returns the identity from a good token', () => {
		expect(readIdTokenClaims(idToken(), NOW)).toEqual({
			ok: true,
			identity: { sub: '1093', email: 'ana@example.com', name: 'Ana Ruiz' },
		});
	});

	it('accepts the bare issuer and the legacy string email_verified', () => {
		const verdict = readIdTokenClaims(
			idToken({ iss: 'accounts.google.com', email_verified: 'true' }),
			NOW,
		);
		expect(verdict.ok).toBe(true);
	});

	it.each([
		['wrong-issuer', { iss: 'https://evil.example' }],
		['wrong-audience', { aud: 'someone-elses-client' }],
		['expired', { exp: NOW / 1000 - 1 }],
		['unverified-email', { email_verified: false }],
		['unverified-email', { email_verified: undefined }],
		['malformed', { sub: '' }],
		['malformed', { email: undefined }],
	])('refuses with %s', (reason, overrides) => {
		expect(readIdTokenClaims(idToken(overrides), NOW)).toEqual({ ok: false, reason });
	});

	it('refuses a token that is not three parts, or whose payload is not JSON', () => {
		expect(readIdTokenClaims('nope', NOW)).toEqual({ ok: false, reason: 'malformed' });
		expect(readIdTokenClaims('a.%%%.c', NOW)).toEqual({ ok: false, reason: 'malformed' });
	});
});

describe('googleDisplayName', () => {
	it('uses the profile name', () => {
		expect(googleDisplayName({ name: 'Ana Ruiz' })).toBe('Ana Ruiz');
	});

	// Never part of the email: the name reaches Slack and the spreadsheets,
	// and the privacy policy says the email does not.
	it('falls back to a neutral label, not the email', () => {
		expect(googleDisplayName({ name: '' })).toBe(NAMELESS_VOLUNTEER);
		expect(googleDisplayName({ name: '  \n\t ' })).toBe(NAMELESS_VOLUNTEER);
	});

	// The name is chosen by a stranger and ends up in Slack posts and sheets.
	it('makes it one tidy line', () => {
		expect(googleDisplayName({ name: 'Ana\nRuiz\r\n<!channel>\u0000  x' })).toBe(
			'Ana Ruiz <!channel> x',
		);
	});

	it('caps the length', () => {
		const long = googleDisplayName({ name: 'a'.repeat(500) });
		expect(long).toHaveLength(MAX_DISPLAY_NAME);
	});

	// Escaping `& < >` at the Slack sinks cannot stop either of these.
	it('defangs anything Slack would auto-link', () => {
		expect(googleDisplayName({ name: 'https://evil.example/login' })).toBe(
			'https evil·example/login',
		);
		expect(googleDisplayName({ name: 'Log in at evil.com' })).toBe('Log in at evil·com');
		expect(googleDisplayName({ name: 'J.R. Ortiz' })).toBe('J.R. Ortiz');
	});

	it("drops Slack's formatting characters", () => {
		expect(googleDisplayName({ name: '*Ana* _Ruiz_ ~x~ `y`' })).toBe('Ana Ruiz x y');
	});

	it('defangs IP addresses and domains in any script', () => {
		expect(googleDisplayName({ name: '10.0.0.1:8080/x' })).toBe('10·0·0·1:8080/x');
		expect(googleDisplayName({ name: 'пример.рф' })).toBe('пример·рф');
	});

	// Characters that draw nothing: a name made only of them is no name, and
	// one hidden inside a domain must not hide it from the link check.
	it('treats every invisible character as a space', () => {
		expect(googleDisplayName({ name: 'ㅤ' })).toBe(NAMELESS_VOLUNTEER);
		expect(googleDisplayName({ name: '⠀ᅟ️' })).toBe(NAMELESS_VOLUNTEER);
		expect(googleDisplayName({ name: 'evil­.com' })).not.toContain('evil.com');
		expect(googleDisplayName({ name: 'evil.c­om' })).not.toContain('evil.com');
		expect(googleDisplayName({ name: 'Ana\u{e0041}\u{e0100}' })).toBe('Ana');
	});

	it('removes bidi overrides and zero-width characters', () => {
		expect(googleDisplayName({ name: 'An​a‮ Ruiz⁦﻿' })).toBe('An a Ruiz');
	});

	it('never cuts a character in half at the cap', () => {
		const emoji = '😀';
		const capped = googleDisplayName({ name: `${'a'.repeat(MAX_DISPLAY_NAME - 1)}${emoji}x` });
		expect(Array.from(capped)).toHaveLength(MAX_DISPLAY_NAME);
		expect(capped.endsWith(emoji)).toBe(true);
	});
});

describe('exchangeGoogleCode', () => {
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

	it('posts the code and verifier and returns the id_token', async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id_token: 'T' }) });

		expect(await exchangeGoogleCode('CODE', 'VERIFIER')).toBe('T');
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://oauth2.googleapis.com/token');
		expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
			client_id: 'client-id.apps.googleusercontent.com',
			client_secret: 'client-secret',
			code: 'CODE',
			code_verifier: 'VERIFIER',
			grant_type: 'authorization_code',
			redirect_uri: 'http://localhost/auth/google/callback',
		});
	});

	it('returns null when Google refuses', async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 400,
			json: async () => ({ error: 'invalid_grant' }),
		});
		expect(await exchangeGoogleCode('CODE', 'VERIFIER')).toBeNull();
	});

	it('returns null when the request itself fails', async () => {
		fetchMock.mockRejectedValue(new Error('network down'));
		expect(await exchangeGoogleCode('CODE', 'VERIFIER')).toBeNull();
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfigured = vi.hoisted(() => ({ value: true }));

vi.mock('$app/environment', () => ({ dev: false }));
vi.mock('$lib/server/env', () => ({
	SLACK_CLIENT_SECRET: 'client-secret',
	GOOGLE_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
	GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
	GOOGLE_REDIRECT_URI: 'http://localhost/auth/google/callback',
	googleSignInConfigured: () => mockConfigured.value,
}));

import { createHash } from 'node:crypto';
import { GET } from './+server.js';
import { verifyState } from '$lib/server/oauth-state.js';

function makeEvent(redirectTo?: string, retry = false) {
	const url = new URL('http://localhost/auth/google');
	if (redirectTo !== undefined) url.searchParams.set('redirectTo', redirectTo);
	if (retry) url.searchParams.set('retry', '1');
	return { url, cookies: { set: vi.fn(), delete: vi.fn() } };
}

async function locationOf(event: ReturnType<typeof makeEvent>): Promise<URL> {
	const location = await Promise.resolve(GET(event as never)).then(
		() => {
			throw new Error('expected a redirect to Google');
		},
		(e: { location: string }) => e.location,
	);
	return new URL(location);
}

function cookieValue(event: ReturnType<typeof makeEvent>, name: string): string | undefined {
	return event.cookies.set.mock.calls.find((c) => c[0] === name)?.[1];
}

describe('GET /auth/google', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockConfigured.value = true;
	});

	it('sends the browser to Google with a signed google-login state', async () => {
		const event = makeEvent('/turfs?chapter=3');
		const url = await locationOf(event);

		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		const verdict = verifyState(url.searchParams.get('state')!);
		expect(verdict).toMatchObject({
			ok: true,
			state: { purpose: 'google-login', destination: '/turfs?chapter=3', isRetry: false },
		});
		// The nonce in the cookie is the one in the state.
		expect(verdict.ok && verdict.state.nonce).toBe(cookieValue(event, 'google_oauth_state'));
	});

	it('cookies the PKCE verifier whose challenge went to Google', async () => {
		const event = makeEvent();
		const url = await locationOf(event);
		const verifier = cookieValue(event, 'google_pkce')!;

		expect(url.searchParams.get('code_challenge')).toBe(
			createHash('sha256').update(verifier).digest('base64url'),
		);
	});

	it('sets every flow cookie httpOnly, lax and secure outside dev', async () => {
		const event = makeEvent('/turfs');
		await locationOf(event);
		for (const name of ['google_oauth_state', 'google_pkce', 'oauth_redirect']) {
			expect(event.cookies.set).toHaveBeenCalledWith(
				name,
				expect.any(String),
				expect.objectContaining({ httpOnly: true, sameSite: 'lax', secure: true, path: '/' }),
			);
		}
	});

	it('drops an off-site destination', async () => {
		const event = makeEvent('https://evil.example');
		const url = await locationOf(event);
		const verdict = verifyState(url.searchParams.get('state')!);
		expect(verdict.ok && verdict.state.destination).toBeNull();
		expect(event.cookies.delete).toHaveBeenCalledWith('oauth_redirect', { path: '/' });
	});

	it('carries the retry flag into the state', async () => {
		const url = await locationOf(makeEvent(undefined, true));
		const verdict = verifyState(url.searchParams.get('state')!);
		expect(verdict.ok && verdict.state.isRetry).toBe(true);
	});

	it('404s when Google sign-in is not configured', async () => {
		mockConfigured.value = false;
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 404 });
	});
});

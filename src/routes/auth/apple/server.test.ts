import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfigured = vi.hoisted(() => ({ value: true }));

vi.mock('$app/environment', () => ({ dev: true }));
vi.mock('$lib/server/env', () => ({
	SLACK_CLIENT_SECRET: 'client-secret',
	APPLE_SIGNIN_SERVICES_ID: 'org.example.turfs',
	APPLE_REDIRECT_URI: 'https://app.example/auth/apple/callback',
	appleSignInConfigured: () => mockConfigured.value,
}));

import { GET } from './+server.js';
import { verifyState } from '$lib/server/oauth-state.js';

function makeEvent(redirectTo?: string, retry = false) {
	const url = new URL('http://localhost/auth/apple');
	if (redirectTo !== undefined) url.searchParams.set('redirectTo', redirectTo);
	if (retry) url.searchParams.set('retry', '1');
	return { url, cookies: { set: vi.fn(), delete: vi.fn() } };
}

async function locationOf(event: ReturnType<typeof makeEvent>): Promise<URL> {
	const location = await Promise.resolve(GET(event as never)).then(
		() => {
			throw new Error('expected a redirect to Apple');
		},
		(e: { location: string }) => e.location,
	);
	return new URL(location);
}

function cookieValue(event: ReturnType<typeof makeEvent>, name: string): string | undefined {
	return event.cookies.set.mock.calls.find((c) => c[0] === name)?.[1];
}

describe('GET /auth/apple', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockConfigured.value = true;
	});

	it('sends the browser to Apple with a signed apple-login state', async () => {
		const event = makeEvent('/turfs?chapter=3');
		const url = await locationOf(event);

		expect(url.origin + url.pathname).toBe('https://appleid.apple.com/auth/authorize');
		expect(url.searchParams.get('response_mode')).toBe('form_post');
		const verdict = verifyState(url.searchParams.get('state')!);
		expect(verdict).toMatchObject({
			ok: true,
			state: { purpose: 'apple-login', destination: '/turfs?chapter=3', isRetry: false },
		});
		// The nonce in the cookie is the one in the state.
		expect(verdict.ok && verdict.state.nonce).toBe(cookieValue(event, 'apple_oauth_state'));
	});

	it('cookies the id-token nonce that went to Apple', async () => {
		const event = makeEvent();
		const url = await locationOf(event);
		expect(url.searchParams.get('nonce')).toBe(cookieValue(event, 'apple_nonce'));
	});

	// Apple returns by a cross-site POST, which would drop lax cookies.
	it('sets every flow cookie httpOnly, SameSite=None and secure, even in dev', async () => {
		const event = makeEvent('/turfs');
		await locationOf(event);
		for (const name of ['apple_oauth_state', 'apple_nonce', 'oauth_redirect']) {
			expect(event.cookies.set).toHaveBeenCalledWith(
				name,
				expect.any(String),
				expect.objectContaining({ httpOnly: true, sameSite: 'none', secure: true, path: '/' }),
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

	it('404s when Apple sign-in is not configured', async () => {
		mockConfigured.value = false;
		await expect(GET(makeEvent() as never)).rejects.toMatchObject({ status: 404 });
	});
});

import { describe, it, expect, vi } from 'vitest';

vi.mock('$app/environment', () => ({ dev: true }));
vi.mock('$lib/server/env', () => ({ SLACK_CLIENT_SECRET: 'client-secret' }));

import { setOAuthCookies } from './oauth-cookies.js';

function fakeCookies() {
	return { set: vi.fn(), delete: vi.fn() };
}

describe('setOAuthCookies', () => {
	it('sets lax cookies for a flow that returns by a same-site GET', () => {
		const cookies = fakeCookies();
		setOAuthCookies(cookies as never, { google_oauth_state: 'N' }, '/turfs');
		expect(cookies.set).toHaveBeenCalledWith(
			'google_oauth_state',
			'N',
			expect.objectContaining({ sameSite: 'lax', httpOnly: true, maxAge: 3600 }),
		);
		expect(cookies.set).toHaveBeenCalledWith(
			'oauth_redirect',
			'/turfs',
			expect.objectContaining({ sameSite: 'lax' }),
		);
	});

	// Apple returns by a cross-site form POST, which drops lax cookies.
	it('sets SameSite=None and Secure for a cross-site return, even in dev', () => {
		const cookies = fakeCookies();
		setOAuthCookies(cookies as never, { apple_oauth_state: 'N', apple_nonce: 'M' }, '/turfs', {
			crossSiteReturn: true,
		});
		for (const name of ['apple_oauth_state', 'apple_nonce', 'oauth_redirect']) {
			expect(cookies.set).toHaveBeenCalledWith(
				name,
				expect.any(String),
				expect.objectContaining({ sameSite: 'none', secure: true, httpOnly: true }),
			);
		}
	});

	it('clears a stale destination when there is none', () => {
		const cookies = fakeCookies();
		setOAuthCookies(cookies as never, { apple_oauth_state: 'N' }, null, { crossSiteReturn: true });
		expect(cookies.delete).toHaveBeenCalledWith('oauth_redirect', { path: '/' });
	});
});

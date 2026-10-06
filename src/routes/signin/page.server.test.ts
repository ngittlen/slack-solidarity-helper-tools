import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfigured = vi.hoisted(() => ({ value: true, apple: true }));

vi.mock('$lib/server/env', () => ({
	googleSignInConfigured: () => mockConfigured.value,
	appleSignInConfigured: () => mockConfigured.apple,
}));

import { load } from './+page.server.js';

function event(query: string, session: App.Locals['session'] = null, lastSignIn?: string) {
	return {
		url: new URL(`http://localhost/signin${query}`),
		locals: { session },
		cookies: { get: (name: string) => (name === 'last_signin' ? lastSignIn : undefined) },
	} as never;
}

describe('/signin load', () => {
	beforeEach(() => {
		mockConfigured.value = true;
		mockConfigured.apple = true;
	});

	it('offers every provider, each carrying the destination', async () => {
		expect(await load(event('?redirectTo=%2Fturfs%3Fchapter%3D3'))).toEqual({
			pageTitle: 'Sign in',
			slackHref: '/auth/slack?redirectTo=%2Fturfs%3Fchapter%3D3',
			googleHref: '/auth/google?redirectTo=%2Fturfs%3Fchapter%3D3',
			appleHref: '/auth/apple?redirectTo=%2Fturfs%3Fchapter%3D3',
			cancelled: null,
			lastUsed: null,
		});
	});

	it('marks the way this browser last signed in', async () => {
		for (const method of ['slack', 'google', 'apple'] as const) {
			expect(await load(event('', null, method))).toMatchObject({ lastUsed: method });
		}
	});

	it('marks nothing for a method no longer offered, or a value it does not know', async () => {
		mockConfigured.apple = false;
		expect(await load(event('', null, 'apple'))).toMatchObject({ lastUsed: null });
		expect(await load(event('', null, 'github'))).toMatchObject({ lastUsed: null });
	});

	it('leaves out whichever of Google and Apple is not configured', async () => {
		mockConfigured.apple = false;
		expect(await load(event(''))).toMatchObject({ googleHref: '/auth/google', appleHref: null });
		mockConfigured.apple = true;
		mockConfigured.value = false;
		expect(await load(event(''))).toMatchObject({ googleHref: null, appleHref: '/auth/apple' });
	});

	it('drops an unsafe destination', async () => {
		const data = (await load(event('?redirectTo=https%3A%2F%2Fevil.example'))) as {
			slackHref: string;
			googleHref: string;
			appleHref: string;
		};
		expect(data.slackHref).toBe('/auth/slack');
		expect(data.googleHref).toBe('/auth/google');
		expect(data.appleHref).toBe('/auth/apple');
	});

	it('says which provider the volunteer cancelled at', async () => {
		expect(await load(event('?cancelled=google'))).toMatchObject({ cancelled: 'google' });
		expect(await load(event('?cancelled=apple'))).toMatchObject({ cancelled: 'apple' });
		expect(await load(event('?cancelled=slack'))).toMatchObject({ cancelled: null });
	});

	it('goes straight on to Slack when neither Google nor Apple is configured', async () => {
		mockConfigured.value = false;
		mockConfigured.apple = false;
		await expect(load(event('?redirectTo=%2Fmembers'))).rejects.toMatchObject({
			status: 302,
			location: '/auth/slack?redirectTo=%2Fmembers',
		});
	});

	it('sends a signed-in Slack member on to where they were going', async () => {
		const session = { slackUserId: 'UADMIN', slackUserName: 'A', isAdmin: true };
		await expect(load(event('?redirectTo=%2Fsettings', session))).rejects.toMatchObject({
			status: 302,
			location: '/settings',
		});
	});

	it('sends a signed-in Google volunteer to /turfs', async () => {
		const session = {
			slackUserId: 'google:1093',
			slackUserName: 'Ana',
			isAdmin: false,
			authProvider: 'google' as const,
		};
		await expect(load(event('?redirectTo=%2Fsettings', session))).rejects.toMatchObject({
			status: 302,
			location: '/turfs',
		});
	});
});

describe('/signin load for an Apple volunteer', () => {
	it('sends a signed-in Apple volunteer to /turfs', async () => {
		const session = {
			slackUserId: 'apple:001.abc',
			slackUserName: 'Bo',
			isAdmin: false,
			authProvider: 'apple' as const,
		};
		await expect(load(event('?redirectTo=%2Fsettings', session))).rejects.toMatchObject({
			status: 302,
			location: '/turfs',
		});
	});
});

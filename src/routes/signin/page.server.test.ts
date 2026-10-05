import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfigured = vi.hoisted(() => ({ value: true }));

vi.mock('$lib/server/env', () => ({
	googleSignInConfigured: () => mockConfigured.value,
}));

import { load } from './+page.server.js';

function event(query: string, session: App.Locals['session'] = null) {
	return { url: new URL(`http://localhost/signin${query}`), locals: { session } } as never;
}

describe('/signin load', () => {
	beforeEach(() => {
		mockConfigured.value = true;
	});

	it('offers both providers, each carrying the destination', async () => {
		expect(await load(event('?redirectTo=%2Fturfs%3Fchapter%3D3'))).toEqual({
			pageTitle: 'Sign in',
			slackHref: '/auth/slack?redirectTo=%2Fturfs%3Fchapter%3D3',
			googleHref: '/auth/google?redirectTo=%2Fturfs%3Fchapter%3D3',
			cancelled: false,
		});
	});

	it('drops an unsafe destination', async () => {
		const data = (await load(event('?redirectTo=https%3A%2F%2Fevil.example'))) as {
			slackHref: string;
			googleHref: string;
		};
		expect(data.slackHref).toBe('/auth/slack');
		expect(data.googleHref).toBe('/auth/google');
	});

	it('says so when the volunteer cancelled at Google', async () => {
		expect(await load(event('?cancelled=1'))).toMatchObject({ cancelled: true });
	});

	it('goes straight on to Slack when Google is not configured', async () => {
		mockConfigured.value = false;
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

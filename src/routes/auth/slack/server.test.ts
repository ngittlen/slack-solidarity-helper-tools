import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAppEnv = vi.hoisted(() => ({ dev: false }));
const mockPrivateEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));

vi.mock('$app/environment', () => ({
	get dev() {
		return mockAppEnv.dev;
	},
}));
vi.mock('$env/dynamic/private', () => ({
	get env() {
		return mockPrivateEnv.env;
	},
}));
vi.mock('$lib/server/env', () => ({
	SLACK_CLIENT_ID: 'client-id',
	// Doubles as the key the state signature is derived from.
	SLACK_CLIENT_SECRET: 'client-secret',
	REDIRECT_URI: 'http://localhost/auth/slack/callback',
}));

import { GET } from './+server.js';
import { verifyState } from '$lib/server/oauth-state.js';

function makeEvent(redirectTo?: string, retry = false) {
	const url = new URL('http://localhost/auth/slack');
	if (redirectTo !== undefined) url.searchParams.set('redirectTo', redirectTo);
	if (retry) url.searchParams.set('retry', '1');
	return { url, cookies: { set: vi.fn(), delete: vi.fn() } };
}

/** The `state` on the Slack authorize URL the handler redirected to. */
async function stateFrom(event: ReturnType<typeof makeEvent>): Promise<string> {
	const location = await Promise.resolve(GET(event as never)).then(
		() => {
			throw new Error('expected a redirect to Slack');
		},
		(e: { location: string }) => e.location,
	);
	const state = new URL(location).searchParams.get('state');
	if (state === null) throw new Error('no state on the authorize URL');
	return state;
}

describe('GET /auth/slack', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockAppEnv.dev = false;
		mockPrivateEnv.env = {};
	});

	it('stashes the requested page in a cookie for the callback to read', async () => {
		const event = makeEvent('/members?user=U123');

		await expect(GET(event as never)).rejects.toMatchObject({ status: 302 });

		expect(event.cookies.set).toHaveBeenCalledWith(
			'oauth_redirect',
			'/members?user=U123',
			expect.objectContaining({ httpOnly: true, path: '/' }),
		);
	});

	it('clears any stale redirect cookie when no page was requested', async () => {
		const event = makeEvent();

		await expect(GET(event as never)).rejects.toMatchObject({ status: 302 });

		expect(event.cookies.delete).toHaveBeenCalledWith('oauth_redirect', { path: '/' });
		expect(event.cookies.set).not.toHaveBeenCalledWith(
			'oauth_redirect',
			expect.anything(),
			expect.anything(),
		);
	});

	it('does not stash an off-site redirectTo', async () => {
		const event = makeEvent('https://evil.example/steal');

		await expect(GET(event as never)).rejects.toMatchObject({ status: 302 });

		expect(event.cookies.delete).toHaveBeenCalledWith('oauth_redirect', { path: '/' });
	});

	it('forwards the requested page to the dev-login bypass', async () => {
		mockAppEnv.dev = true;
		mockPrivateEnv.env = { DEV_SLACK_USER_ID: 'UDEV' };

		await expect(GET(makeEvent('/settings') as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/dev-login?redirectTo=%2Fsettings',
		});
	});

	it('redirects to Slack with the state cookie set', async () => {
		const event = makeEvent();

		await expect(GET(event as never)).rejects.toMatchObject({
			status: 302,
			location: expect.stringContaining('https://slack.com/oauth/v2/authorize?'),
		});
		expect(event.cookies.set).toHaveBeenCalledWith(
			'oauth_state',
			expect.any(String),
			expect.objectContaining({ httpOnly: true }),
		);
	});

	// The state is signed so the callback can still learn something from it when
	// the login comes back in a browser that never had the cookie — see
	// $lib/server/oauth-state.ts.
	it('cookies the nonce from the signed state, not the whole state', async () => {
		const event = makeEvent();
		const state = await stateFrom(event);

		const verdict = verifyState(state);
		expect(verdict.ok).toBe(true);
		const nonce = verdict.ok ? verdict.state.nonce : '';
		expect(event.cookies.set).toHaveBeenCalledWith(
			'oauth_state',
			nonce,
			expect.objectContaining({ httpOnly: true }),
		);
		expect(nonce).not.toBe(state);
	});

	it('signs the requested page into the state so it survives a lost cookie jar', async () => {
		const verdict = verifyState(await stateFrom(makeEvent('/members?user=U123')));

		expect(verdict.ok && verdict.state.destination).toBe('/members?user=U123');
	});

	it('does not sign an off-site destination into the state', async () => {
		const verdict = verifyState(await stateFrom(makeEvent('https://evil.example/steal')));

		expect(verdict.ok && verdict.state.destination).toBe(null);
	});

	// Set by the callback when it restarts a login; the callback refuses to
	// restart a second time, so a browser that drops cookies cannot ping-pong.
	it('marks a retried attempt in the state, and an ordinary one as not a retry', async () => {
		const retried = verifyState(await stateFrom(makeEvent('/members', true)));
		const first = verifyState(await stateFrom(makeEvent('/members')));

		expect(retried.ok && retried.state.isRetry).toBe(true);
		expect(first.ok && first.state.isRetry).toBe(false);
	});

	// chat:write is requested at login so there is no second authorization dance
	// the first time an admin runs an info command. It must be the ONLY user
	// scope: Slack fails the whole authorization with "Invalid permissions
	// requested" if an identity.* scope is asked for alongside anything else.
	it('requests chat:write alone as the user scope', async () => {
		const event = makeEvent();

		// The handler signals the redirect by throwing, so the location arrives on
		// the rejection rather than as a return value.
		const redirect = await Promise.resolve(GET(event as never)).then(
			() => {
				throw new Error('expected a redirect to Slack');
			},
			(e: { location: string }) => e.location,
		);
		const userScope = new URL(redirect).searchParams.get('user_scope');

		expect(userScope?.split(',')).toEqual(['chat:write']);
	});
});

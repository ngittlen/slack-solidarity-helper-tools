import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$app/environment', () => ({ dev: false }));
vi.mock('$lib/server/env', () => ({
	SLACK_CLIENT_ID: 'client-id',
	SLACK_CLIENT_SECRET: 'client-secret',
	REDIRECT_URI: 'http://localhost/auth/slack/callback',
}));
const mockTeamId = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/slack-team.js', () => ({ workspaceTeamId: mockTeamId }));

import { GET } from './+server.js';
import { verifyState } from '$lib/server/oauth-state.js';

type Session = App.Locals['session'];

const ADMIN: Session = { slackUserId: 'UADMIN', slackUserName: 'A', isAdmin: true };
const MOD: Session = { slackUserId: 'UMOD', slackUserName: 'M', isAdmin: false, isModerator: true };
const MEMBER: Session = { slackUserId: 'UMEM', slackUserName: 'V', isAdmin: false };

function makeEvent(session: Session, retry = false) {
	const url = new URL('http://localhost/auth/slack/post-as-you');
	if (retry) url.searchParams.set('retry', '1');
	return { url, locals: { session }, cookies: { set: vi.fn(), delete: vi.fn() } };
}

async function slackUrl(event: ReturnType<typeof makeEvent>): Promise<URL> {
	const location = await Promise.resolve(GET(event as never)).then(
		() => {
			throw new Error('expected a redirect');
		},
		(e: { location: string }) => e.location,
	);
	return new URL(location);
}

describe('GET /auth/slack/post-as-you', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTeamId.mockResolvedValue(null);
	});

	it('asks an admin for chat:write alone', async () => {
		const url = await slackUrl(makeEvent(ADMIN));

		expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
		expect(url.searchParams.get('user_scope')).toBe('chat:write');
	});

	it('asks a moderator too', async () => {
		const url = await slackUrl(makeEvent(MOD));

		expect(url.searchParams.get('user_scope')).toBe('chat:write');
	});

	it('signs the state as a post-as-you grant headed back to /post-as-you', async () => {
		const verdict = verifyState((await slackUrl(makeEvent(ADMIN))).searchParams.get('state')!);

		expect(verdict).toMatchObject({
			ok: true,
			state: { purpose: 'post-as-you', destination: '/post-as-you', isRetry: false },
		});
	});

	it('carries the retry flag the callback set', async () => {
		const verdict = verifyState(
			(await slackUrl(makeEvent(ADMIN, true))).searchParams.get('state')!,
		);

		expect(verdict.ok && verdict.state.isRetry).toBe(true);
	});

	// The whole point of the split: nobody else is ever shown the screen.
	it('refuses anyone who is not an admin or moderator', async () => {
		await expect(GET(makeEvent(MEMBER) as never)).rejects.toMatchObject({ status: 403 });
	});

	it('sends a signed-out visitor to sign in first', async () => {
		await expect(GET(makeEvent(null) as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/slack?redirectTo=%2Fpost-as-you',
		});
	});
});

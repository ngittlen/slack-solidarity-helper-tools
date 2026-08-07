import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { POST } from './+server.js';

const mockViewsOpen = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/slack', () => ({ slack: { views: { open: mockViewsOpen } } }));
vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/env', () => ({
	SLACK_SIGNING_SECRET: 'test-signing-secret',
	SLACK_SUPERUSER_ID: 'U_SUPER',
}));

const SECRET = 'test-signing-secret';

function signedCommand(
	fields: Record<string, string>,
	opts: { secret?: string; ageSeconds?: number } = {},
) {
	const body = new URLSearchParams({
		command: '/member-note',
		user_id: 'U_ADMIN',
		trigger_id: 'trigger.123',
		channel_id: 'C_CHAN',
		text: '',
		...fields,
	}).toString();
	const secret = opts.secret ?? SECRET;
	const timestamp = Math.floor(Date.now() / 1000 - (opts.ageSeconds ?? 0)).toString();
	const sig = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
	return new Request('http://localhost/api/slack/commands', {
		method: 'POST',
		body,
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'x-slack-signature': sig,
			'x-slack-request-timestamp': timestamp,
		},
	});
}

const call = (request: Request) => POST({ request } as never);

beforeEach(() => {
	vi.clearAllMocks();
	mockLoadSettings.mockResolvedValue({
		allowedSlackUserIds: new Set(['U_ADMIN']),
		warningDmMessage: 'This is your {{nth}} warning.',
	});
	mockViewsOpen.mockResolvedValue({ ok: true });
});

describe('POST /api/slack/commands — signature', () => {
	it('rejects a request signed with the wrong secret', async () => {
		const res = await call(signedCommand({}, { secret: 'wrong' }));
		expect(res.status).toBe(401);
		expect(mockViewsOpen).not.toHaveBeenCalled();
	});

	it('rejects a replayed request older than five minutes', async () => {
		const res = await call(signedCommand({}, { ageSeconds: 400 }));
		expect(res.status).toBe(401);
	});

	it('rejects a request with no signature headers', async () => {
		const res = await call(
			new Request('http://localhost/api/slack/commands', {
				method: 'POST',
				body: 'command=%2Fmember-note',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			}),
		);
		expect(res.status).toBe(401);
	});
});

describe('POST /api/slack/commands — authorization', () => {
	it('refuses a non-admin ephemerally without opening the modal', async () => {
		const res = await call(signedCommand({ user_id: 'U_RANDOM' }));

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ response_type: 'ephemeral' });
		expect(mockViewsOpen).not.toHaveBeenCalled();
	});

	it('allows an allowlisted admin', async () => {
		await call(signedCommand({ user_id: 'U_ADMIN' }));
		expect(mockViewsOpen).toHaveBeenCalledTimes(1);
	});

	// The superuser id comes from the environment, so a DB outage must not lock
	// the workspace owner out of moderation tooling.
	it('passes the superuser through the admin check when loadSettings throws', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockLoadSettings.mockRejectedValue(new Error('db down'));

		const res = await call(signedCommand({ user_id: 'U_SUPER' }));

		// They still can't get a modal (the template read is the same failing
		// call), but the failure they see is the DB one — not a refusal.
		const text = (await res.json()).text as string;
		expect(text).toContain('Could not open');
		expect(text).not.toContain('not authorized');
	});

	it('opens the modal for the superuser when the allowlist simply omits them', async () => {
		mockLoadSettings.mockResolvedValue({
			allowedSlackUserIds: new Set<string>(),
			warningDmMessage: '',
		});

		await call(signedCommand({ user_id: 'U_SUPER' }));

		expect(mockViewsOpen).toHaveBeenCalledTimes(1);
	});

	it('fails closed for a non-superuser when loadSettings throws', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockLoadSettings.mockRejectedValue(new Error('db down'));

		const res = await call(signedCommand({ user_id: 'U_ADMIN' }));

		expect((await res.json()).text).toContain('not authorized');
		expect(mockViewsOpen).not.toHaveBeenCalled();
	});
});

describe('POST /api/slack/commands — modal', () => {
	it('opens the modal with the payload’s trigger_id', async () => {
		await call(signedCommand({ trigger_id: 'trigger.abc' }));

		expect(mockViewsOpen).toHaveBeenCalledWith(
			expect.objectContaining({ trigger_id: 'trigger.abc' }),
		);
	});

	it('returns an empty 200 so no command echo appears in the channel', async () => {
		const res = await call(signedCommand({}));

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('');
	});

	it('prefills the member from an escaped mention', async () => {
		await call(signedCommand({ text: '<@U0TARGET|jordan>' }));

		const view = mockViewsOpen.mock.calls[0]![0].view;
		const memberBlock = view.blocks.find((b: { block_id: string }) => b.block_id === 'member');
		expect(memberBlock.element.initial_user).toBe('U0TARGET');
	});

	it('opens unprefilled when the text has no escaped mention', async () => {
		await call(signedCommand({ text: 'jordan' }));

		const view = mockViewsOpen.mock.calls[0]![0].view;
		const memberBlock = view.blocks.find((b: { block_id: string }) => b.block_id === 'member');
		expect(memberBlock.element.initial_user).toBeUndefined();
	});

	it('carries the invoking channel and source through private_metadata', async () => {
		await call(signedCommand({ channel_id: 'C_HERE' }));

		const view = mockViewsOpen.mock.calls[0]![0].view;
		expect(JSON.parse(view.private_metadata)).toEqual({ channelId: 'C_HERE', source: 'slash' });
	});

	it('reports an ephemeral error when views.open fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockViewsOpen.mockRejectedValue(new Error('trigger_id expired'));

		const res = await call(signedCommand({}));

		expect(res.status).toBe(200);
		expect((await res.json()).text).toContain('Could not open');
	});

	it('ignores an unrecognized command', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		const res = await call(signedCommand({ command: '/something-else' }));

		expect(mockViewsOpen).not.toHaveBeenCalled();
		expect((await res.json()).response_type).toBe('ephemeral');
	});
});

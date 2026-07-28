import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './+server.js';

const mockLookupByEmail = vi.hoisted(() => vi.fn());
const mockConversationsInvite = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/slack', () => ({
	slack: {
		users: { lookupByEmail: mockLookupByEmail },
		conversations: { invite: mockConversationsInvite },
	},
}));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));
vi.mock('$lib/server/env', () => ({
	WEBHOOK_SECRET: 'secret123',
}));

function makeEvent(params: Record<string, string>) {
	const url = new URL('http://localhost/coalition-invite');
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return { url };
}

describe('GET /coalition-invite', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLookupByEmail.mockResolvedValue({ user: { id: 'U123' } });
		mockConversationsInvite.mockResolvedValue({ ok: true });
		mockLoadSettings.mockResolvedValue({
			coalitionChannelMap: [
				{ group: 'labor', channelId: 'C_LABOR', name: 'Labor Unions', userListId: null },
				{ group: 'housing', channelId: 'C_HOUSING', name: '', userListId: null },
			],
		});
	});

	it('returns 401 when secret is wrong', async () => {
		const res = await GET(
			makeEvent({ secret: 'wrong', email: 'a@b.com', coalition: 'labor' }) as never,
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'Unauthorized' });
		expect(mockLookupByEmail).not.toHaveBeenCalled();
	});

	it('returns 401 when secret is missing', async () => {
		const res = await GET(makeEvent({ email: 'a@b.com', coalition: 'labor' }) as never);
		expect(res.status).toBe(401);
	});

	it('returns 400 when email is missing', async () => {
		const res = await GET(makeEvent({ secret: 'secret123', coalition: 'labor' }) as never);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'email is required' });
	});

	it('returns 400 when coalition is missing', async () => {
		const res = await GET(makeEvent({ secret: 'secret123', email: 'a@b.com' }) as never);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'coalition is required' });
	});

	it('returns 400 for invalid email (no @)', async () => {
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'notanemail', coalition: 'labor' }) as never,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Invalid email address' });
	});

	it('returns 400 for unknown coalition', async () => {
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'a@b.com', coalition: 'mystery' }) as never,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Unknown coalition: mystery' });
	});

	it('matches coalition name case-insensitively', async () => {
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'a@b.com', coalition: 'LABOR' }) as never,
		);
		expect(res.status).toBe(200);
		expect(mockConversationsInvite).toHaveBeenCalledWith({ channel: 'C_LABOR', users: 'U123' });
	});

	it('returns JSON 503 when the settings read fails, preserving the error contract', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockLoadSettings.mockRejectedValueOnce(new Error('db down'));
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'a@b.com', coalition: 'labor' }) as never,
		);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			error: 'Settings are temporarily unavailable. Retry shortly.',
		});
		expect(mockConversationsInvite).not.toHaveBeenCalled();
	});

	it('matches a stored group containing uppercase characters', async () => {
		// The DB stores Solidarity property keys verbatim — matching must be
		// case-insensitive on both sides, not just the query param.
		mockLoadSettings.mockResolvedValue({
			coalitionChannelMap: [
				{ group: 'Faith-Leaders', channelId: 'C_FAITH', name: 'Faith Leaders', userListId: null },
			],
		});
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'a@b.com', coalition: 'faith-leaders' }) as never,
		);
		expect(res.status).toBe(200);
		expect(mockConversationsInvite).toHaveBeenCalledWith({ channel: 'C_FAITH', users: 'U123' });
	});

	it('returns 404 when no Slack user is found for the email', async () => {
		mockLookupByEmail.mockRejectedValueOnce(new Error('users_not_found'));
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'nobody@b.com', coalition: 'labor' }) as never,
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'No Slack user found for nobody@b.com' });
		expect(mockConversationsInvite).not.toHaveBeenCalled();
	});

	it('returns 404 when Slack returns a result without a user id', async () => {
		mockLookupByEmail.mockResolvedValueOnce({ user: undefined });
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'a@b.com', coalition: 'labor' }) as never,
		);
		expect(res.status).toBe(404);
		expect(mockConversationsInvite).not.toHaveBeenCalled();
	});

	it('returns 502 when lookupByEmail fails for unrelated reasons', async () => {
		mockLookupByEmail.mockRejectedValueOnce(new Error('rate_limited'));
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'a@b.com', coalition: 'labor' }) as never,
		);
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: 'Failed to look up Slack user' });
	});

	it('returns 200 with already_in_channel when the user is already in the channel', async () => {
		mockConversationsInvite.mockRejectedValueOnce(new Error('already_in_channel'));
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'a@b.com', coalition: 'labor' }) as never,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, already_in_channel: true });
	});

	it('returns 502 when invite fails for unrelated reasons', async () => {
		mockConversationsInvite.mockRejectedValueOnce(new Error('channel_not_found'));
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'a@b.com', coalition: 'labor' }) as never,
		);
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: 'Failed to invite user to channel' });
	});

	it('returns 200 success on the happy path', async () => {
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'a@b.com', coalition: 'labor' }) as never,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		expect(mockLookupByEmail).toHaveBeenCalledWith({ email: 'a@b.com' });
		expect(mockConversationsInvite).toHaveBeenCalledWith({ channel: 'C_LABOR', users: 'U123' });
	});
});

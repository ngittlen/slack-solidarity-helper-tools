import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockBlock = vi.hoisted(() => vi.fn());
const mockUnblock = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockValidateSlackUser = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({ slack: {} }));
vi.mock('$lib/server/env', () => ({ SLACK_SUPERUSER_ID: 'U_SUPER' }));
vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));
vi.mock('$lib/server/settings-validation', () => ({ validateSlackUser: mockValidateSlackUser }));
vi.mock('$lib/server/van/blocklist', () => ({
	blockFromTurfCheckout: mockBlock,
	unblockFromTurfCheckout: mockUnblock,
}));

const authed = {
	locals: { session: { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true } },
};
const unauthed = { locals: { session: null } };
const nonAdmin = {
	locals: { session: { slackUserId: 'U_VOL', slackUserName: 'Bob', isAdmin: false } },
};

function makeEvent(session: typeof authed | typeof unauthed | typeof nonAdmin, body: unknown) {
	return { ...session, request: { json: async () => body } as Request };
}

describe('POST /api/settings/van-blocklist', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue({ allowedSlackUserIds: new Set(['U_ADMIN']) });
		mockValidateSlackUser.mockResolvedValue({ ok: true, displayName: 'Bob' });
		mockBlock.mockResolvedValue({ releasedMapRouteIds: [4101], sessionsRevoked: 2 });
		mockUnblock.mockResolvedValue(undefined);
	});

	it('returns 401 when not authenticated', async () => {
		const res = await POST(makeEvent(unauthed, { action: 'block', userId: 'U_VOL' }) as never);
		expect(res.status).toBe(401);
		expect(mockBlock).not.toHaveBeenCalled();
	});

	it('returns 403 when not admin', async () => {
		const res = await POST(makeEvent(nonAdmin, { action: 'block', userId: 'U_X' }) as never);
		expect(res.status).toBe(403);
		expect(mockBlock).not.toHaveBeenCalled();
	});

	it('blocks a member and reports what the block freed', async () => {
		const res = await POST(
			makeEvent(authed, { action: 'block', userId: 'U_VOL', reason: 'left the campaign' }) as never,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, releasedTurfs: 1, sessionsRevoked: 2 });
		expect(mockBlock).toHaveBeenCalledWith(
			{},
			{ slackUserId: 'U_VOL', displayName: 'Bob', reason: 'left the campaign' },
			{ id: 'U_ADMIN', name: 'Alice' },
		);
	});

	// The lockout guards. Each must refuse loudly, not drop the write silently.
	it('refuses to block another admin', async () => {
		mockLoadSettings.mockResolvedValue({
			allowedSlackUserIds: new Set(['U_ADMIN', 'U_OTHER_ADMIN']),
		});
		const res = await POST(
			makeEvent(authed, { action: 'block', userId: 'U_OTHER_ADMIN' }) as never,
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/admin/i);
		expect(mockBlock).not.toHaveBeenCalled();
	});

	it('refuses to block the superuser', async () => {
		const res = await POST(makeEvent(authed, { action: 'block', userId: 'U_SUPER' }) as never);
		expect(res.status).toBe(400);
		expect(mockBlock).not.toHaveBeenCalled();
	});

	it('refuses to block yourself', async () => {
		const res = await POST(makeEvent(authed, { action: 'block', userId: 'U_ADMIN' }) as never);
		expect(res.status).toBe(400);
		expect(mockBlock).not.toHaveBeenCalled();
	});

	it('unblocks without validating against Slack, so stale entries clear', async () => {
		mockValidateSlackUser.mockResolvedValue({ ok: false, error: 'unknown user' });
		const res = await POST(makeEvent(authed, { action: 'unblock', userId: 'U_GONE' }) as never);
		expect(res.status).toBe(200);
		expect(mockUnblock).toHaveBeenCalledWith({}, 'U_GONE', { id: 'U_ADMIN', name: 'Alice' });
	});

	it('passes a transient Slack failure through as 503', async () => {
		mockValidateSlackUser.mockResolvedValue({ ok: false, error: 'slack down', transient: true });
		const res = await POST(makeEvent(authed, { action: 'block', userId: 'U_VOL' }) as never);
		expect(res.status).toBe(503);
	});

	it('rejects a bad action and a missing userId', async () => {
		expect((await POST(makeEvent(authed, { action: 'nope', userId: 'U1' }) as never)).status).toBe(
			400,
		);
		expect((await POST(makeEvent(authed, { action: 'block', userId: '' }) as never)).status).toBe(
			400,
		);
	});
});

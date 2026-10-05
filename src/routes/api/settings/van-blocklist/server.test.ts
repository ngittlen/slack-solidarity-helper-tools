import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockBlock = vi.hoisted(() => vi.fn());
const mockSendDm = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());
const mockUnblock = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockValidateSlackUser = vi.hoisted(() => vi.fn());
const mockBlockTargetName = vi.hoisted(() => vi.fn());
const mockLoadVanBlockedUsers = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({ slack: { chat: { postMessage: mockPostMessage } } }));
vi.mock('$lib/server/slack-dm', () => ({ sendDm: mockSendDm }));
vi.mock('$lib/server/env', () => ({ SLACK_SUPERUSER_ID: 'U_SUPER' }));
vi.mock('$lib/server/settings', () => ({
	loadSettings: mockLoadSettings,
	loadVanBlockedUsers: mockLoadVanBlockedUsers,
}));
vi.mock('$lib/server/google-volunteers', () => ({ googleBlockTargetName: mockBlockTargetName }));
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
		mockBlock.mockResolvedValue({
			released: [{ turfId: 4101, name: 'Turf 01' }],
			sessionsRevoked: 2,
		});
		mockSendDm.mockResolvedValue(true);
		mockPostMessage.mockResolvedValue({ ok: true });
		mockUnblock.mockResolvedValue(undefined);
		mockBlockTargetName.mockResolvedValue(null);
		mockLoadVanBlockedUsers.mockResolvedValue([]);
	});

	/** The admin-channel line, once the detached announce has run. */
	async function postedNotice(): Promise<string> {
		await vi.waitFor(() => expect(mockPostMessage).toHaveBeenCalled());
		return mockPostMessage.mock.calls[0]![0].text as string;
	}

	describe('a Google volunteer', () => {
		beforeEach(() => {
			mockLoadSettings.mockResolvedValue({
				allowedSlackUserIds: new Set(['U_ADMIN']),
				slackMemberNoteChannelId: 'C_NOTES',
			});
		});

		it('is blocked by their stored name, without asking Slack about them', async () => {
			mockBlockTargetName.mockResolvedValue('Ana Ruiz');
			const res = await POST(
				makeEvent(authed, { action: 'block', userId: 'google:7', reason: 'spam' }) as never,
			);
			expect(res.status).toBe(200);
			expect(mockValidateSlackUser).not.toHaveBeenCalled();
			expect(mockBlock).toHaveBeenCalledWith(
				{},
				{ slackUserId: 'google:7', displayName: 'Ana Ruiz', reason: 'spam' },
				{ id: 'U_ADMIN', name: 'Alice' },
			);

			// Named, not mentioned; no email in Slack; and no claim of a DM that
			// cannot have been sent.
			const notice = await postedNotice();
			expect(notice).toContain('*Ana Ruiz* (signed in with Google)');
			expect(notice).not.toContain('<@google:7>');
			expect(notice).not.toContain('ana@example.com');
			expect(notice).not.toContain('DMed');
		});

		it("escapes the volunteer's chosen name in the admin channel", async () => {
			mockBlockTargetName.mockResolvedValue('<!channel> <https://evil.example|re-auth>');
			await POST(makeEvent(authed, { action: 'block', userId: 'google:7' }) as never);
			const notice = await postedNotice();
			expect(notice).not.toContain('<!channel>');
			expect(notice).toContain('*&lt;!channel&gt; &lt;https://evil.example|re-auth&gt;*');
		});

		it('cannot be blocked without ever having signed in', async () => {
			const res = await POST(makeEvent(authed, { action: 'block', userId: 'google:404' }) as never);
			expect(res.status).toBe(400);
			expect(mockBlock).not.toHaveBeenCalled();
		});

		it('is unblocked by the name on the block, which outlives their record', async () => {
			mockLoadVanBlockedUsers.mockResolvedValue([
				{ slackUserId: 'google:7', displayName: 'Ana Ruiz' },
			]);
			const res = await POST(makeEvent(authed, { action: 'unblock', userId: 'google:7' }) as never);
			expect(res.status).toBe(200);
			expect(mockUnblock).toHaveBeenCalledWith({}, 'google:7', { id: 'U_ADMIN', name: 'Alice' });
			expect(await postedNotice()).toContain('*Ana Ruiz* (signed in with Google) was unblocked');
		});
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

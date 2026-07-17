import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockGetUserByEmail = vi.hoisted(() => vi.fn());
const mockGetSlackChannels = vi.hoisted(() => vi.fn());
const mockUsersInfo = vi.hoisted(() => vi.fn());
const mockConversationsOpen = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));
vi.mock('$lib/server/solidarity', () => ({ getUserByEmail: mockGetUserByEmail }));
vi.mock('$lib/server/autocomplete-sources', () => ({ getSlackChannels: mockGetSlackChannels }));
vi.mock('$lib/server/slack', () => ({
	slack: {
		users: { info: mockUsersInfo },
		conversations: { open: mockConversationsOpen },
		chat: { postMessage: mockPostMessage },
	},
}));

const authed = {
	locals: { session: { slackUserId: 'U_ME', slackUserName: 'Admin', isAdmin: true } },
};

function makeEvent(session: unknown, body: unknown) {
	return { ...(session as object), request: { json: async () => body } as Request };
}

/** The mrkdwn section block's text — where {{channels}} lands. */
function sectionText(): string {
	const call = mockPostMessage.mock.calls.at(-1)![0] as {
		blocks: Array<{ type: string; text?: { text: string } }>;
	};
	return call.blocks.find((b) => b.type === 'section')!.text!.text;
}

describe('POST /api/settings/welcome-dm-test', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue({
			welcomeDmMessage: 'Welcome to {{channels}}!',
			chapterChannelMap: [
				{ chapterId: 42, channelId: 'C_MINE', name: 'Mine' },
				{ chapterId: 99, channelId: 'C_OTHER', name: 'Other' },
			],
		});
		mockUsersInfo.mockResolvedValue({ user: { profile: { email: 'me@example.com' } } });
		mockGetUserByEmail.mockResolvedValue({ chapter_id: null, chapter_ids: [42] });
		mockGetSlackChannels.mockResolvedValue({ items: [], fetchedAt: 0 });
		mockConversationsOpen.mockResolvedValue({ channel: { id: 'DM_ME' } });
		mockPostMessage.mockResolvedValue({ ok: true });
	});

	it('401/403 for unauthenticated / non-admin', async () => {
		expect((await POST(makeEvent({ locals: { session: null } }, {}) as never)).status).toBe(401);
		expect(
			(
				await POST(
					makeEvent({ locals: { session: { slackUserId: 'U', isAdmin: false } } }, {}) as never,
				)
			).status,
		).toBe(403);
	});

	it("fills {{channels}} with the admin's OWN chapter channels, not others", async () => {
		const res = await POST(makeEvent(authed, {}) as never);
		expect(res.status).toBe(200);
		expect(mockConversationsOpen).toHaveBeenCalledWith({ users: 'U_ME' });
		const text = sectionText();
		expect(text).toContain('<#C_MINE>');
		expect(text).not.toContain('<#C_OTHER>');
	});

	it('previews the unsaved textarea value when provided', async () => {
		const res = await POST(
			makeEvent(authed, { welcomeDmMessage: 'Draft for {{channels}}' }) as never,
		);
		expect(res.status).toBe(200);
		expect(sectionText()).toContain('Draft for <#C_MINE>');
	});

	it('falls back to a labeled placeholder when the admin is not a mapped member', async () => {
		mockGetUserByEmail.mockResolvedValue(null);
		const res = await POST(makeEvent(authed, {}) as never);
		expect(res.status).toBe(200);
		const text = sectionText();
		expect(text).toContain('#your-chapter-channel(s)');
		expect(text).not.toContain('<#C_MINE>');
	});

	it('still sends when the Slack lookup throws (placeholder, no crash)', async () => {
		mockUsersInfo.mockRejectedValue(new Error('scope'));
		const res = await POST(makeEvent(authed, {}) as never);
		expect(res.status).toBe(200);
		expect(sectionText()).toContain('#your-chapter-channel(s)');
	});
});
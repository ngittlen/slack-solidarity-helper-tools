import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOpen = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/slack.js', () => ({
	slack: { conversations: { open: mockOpen }, chat: { postMessage: mockPostMessage } },
}));

const { sendDm } = await import('./slack-dm.js');

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mockOpen.mockResolvedValue({ ok: true, channel: { id: 'D123' } });
	mockPostMessage.mockResolvedValue({ ok: true });
});

describe('sendDm', () => {
	it('opens the DM channel and posts into it', async () => {
		expect(await sendDm('U_VOL', 'hello', '[test]')).toBe(true);
		expect(mockOpen).toHaveBeenCalledWith({ users: 'U_VOL' });
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({ channel: 'D123', text: 'hello' }),
		);
	});

	// The mrkdwn renders from the block; `text` stays as the notification
	// fallback, which is what shows on a lock screen.
	it('sends the same text as a section block and as the fallback', async () => {
		await sendDm('U_VOL', 'hello', '[test]');
		const call = mockPostMessage.mock.calls[0]![0];
		expect(call.text).toBe('hello');
		expect(call.blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'hello' } }]);
	});

	// Deactivated accounts and bots. Not an exception — just a person who cannot
	// be reached, and the caller needs to know so it does not record a delivery
	// that never happened.
	it.each([
		['no channel', { ok: true }],
		['a channel with no id', { ok: true, channel: {} }],
	])('reports failure when Slack returns %s', async (_label, response) => {
		mockOpen.mockResolvedValue(response);
		expect(await sendDm('U_GONE', 'hello', '[test]')).toBe(false);
		expect(mockPostMessage).not.toHaveBeenCalled();
	});

	it.each([
		['conversations.open', () => mockOpen.mockRejectedValue(new Error('slack down'))],
		['chat.postMessage', () => mockPostMessage.mockRejectedValue(new Error('slack down'))],
	])('returns false rather than throwing when %s fails', async (_label, arrange) => {
		arrange();
		await expect(sendDm('U_VOL', 'hello', '[test]')).resolves.toBe(false);
	});

	it('tags its log lines with the caller’s prefix', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockOpen.mockResolvedValue({ ok: true });
		await sendDm('U_GONE', 'hello', '[van]');
		expect(warn.mock.calls[0]![0]).toContain('[van]');
	});
});

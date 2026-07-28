import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockEnsureSeeded = vi.hoisted(() => vi.fn());
const mockSaveEntries = vi.hoisted(() => vi.fn());
const mockDeleteEntries = vi.hoisted(() => vi.fn());
const mockValidateChannel = vi.hoisted(() => vi.fn());
const mockValidateChapter = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({ slack: {} }));
vi.mock('$lib/server/env', () => ({ SOLIDARITY_API_TOKEN: 'tok' }));
vi.mock('$lib/server/settings', () => ({
	ensureChapterChannelMapSeeded: mockEnsureSeeded,
	saveChapterChannelEntries: mockSaveEntries,
	deleteChapterChannelEntries: mockDeleteEntries,
}));
vi.mock('$lib/server/settings-validation', () => ({
	validateSlackChannel: mockValidateChannel,
	validateSolidarityChapter: mockValidateChapter,
}));

const authed = {
	locals: { session: { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true } },
};
const unauthed = { locals: { session: null } };
const nonAdmin = {
	locals: { session: { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false } },
};

function makeEvent(session: typeof authed | typeof unauthed | typeof nonAdmin, body: unknown) {
	return {
		...session,
		request: { json: async () => body } as Request,
	};
}

describe('POST /api/settings/chapter-channels', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockEnsureSeeded.mockResolvedValue(undefined);
		mockSaveEntries.mockResolvedValue(undefined);
		mockDeleteEntries.mockResolvedValue(undefined);
		mockValidateChannel.mockResolvedValue({ ok: true, name: 'general' });
		mockValidateChapter.mockImplementation(async (_tok: string, id: number) => ({
			ok: true,
			name: `Chapter ${id}`,
		}));
	});

	it('returns 401 when not authenticated', async () => {
		const res = await POST(
			makeEvent(unauthed, { action: 'add', chapterIds: [1], channelId: 'C1' }) as never,
		);
		expect(res.status).toBe(401);
		expect(mockSaveEntries).not.toHaveBeenCalled();
	});

	it('returns 403 when not admin', async () => {
		const res = await POST(
			makeEvent(nonAdmin, { action: 'add', chapterIds: [1], channelId: 'C1' }) as never,
		);
		expect(res.status).toBe(403);
		expect(mockSaveEntries).not.toHaveBeenCalled();
	});

	it('returns 400 for an unknown action', async () => {
		const res = await POST(
			makeEvent(authed, { action: 'replace', chapterIds: [1], channelId: 'C1' }) as never,
		);
		expect(res.status).toBe(400);
	});

	it('returns 400 for empty or non-integer chapterIds', async () => {
		for (const chapterIds of [[], ['1'], [1.5], 'nope', undefined]) {
			const res = await POST(
				makeEvent(authed, { action: 'add', chapterIds, channelId: 'C1' }) as never,
			);
			expect(res.status).toBe(400);
		}
	});

	it('returns 400 for a missing or blank channelId', async () => {
		for (const channelId of ['', '   ', 7, undefined]) {
			const res = await POST(
				makeEvent(authed, { action: 'add', chapterIds: [1], channelId }) as never,
			);
			expect(res.status).toBe(400);
		}
	});

	it('add: seeds then saves the whole batch in one call with the validated chapter names', async () => {
		const res = await POST(
			makeEvent(authed, { action: 'add', chapterIds: [1, 2], channelId: 'C1' }) as never,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		expect(mockEnsureSeeded).toHaveBeenCalledTimes(1);
		expect(mockSaveEntries).toHaveBeenCalledTimes(1);
		expect(mockSaveEntries).toHaveBeenCalledWith(
			expect.anything(),
			[
				{ chapterId: 1, name: 'Chapter 1' },
				{ chapterId: 2, name: 'Chapter 2' },
			],
			'C1',
			{ id: 'U123', name: 'Alice' },
		);
		// Seed must run before the first write so an empty table inherits the env
		// map instead of shadowing it away.
		expect(mockEnsureSeeded.mock.invocationCallOrder[0]).toBeLessThan(
			mockSaveEntries.mock.invocationCallOrder[0]!,
		);
	});

	it('add: 400 when the channel id is not a valid choice, nothing written', async () => {
		mockValidateChannel.mockResolvedValue({
			ok: false,
			error: 'Not a valid Slack channel choice.',
			transient: false,
		});
		const res = await POST(
			makeEvent(authed, { action: 'add', chapterIds: [1], channelId: 'C_BAD' }) as never,
		);
		expect(res.status).toBe(400);
		expect(mockSaveEntries).not.toHaveBeenCalled();
		expect(mockEnsureSeeded).not.toHaveBeenCalled();
	});

	it('add: 503 when the channel list is transiently unavailable', async () => {
		mockValidateChannel.mockResolvedValue({ ok: false, error: 'unavailable', transient: true });
		const res = await POST(
			makeEvent(authed, { action: 'add', chapterIds: [1], channelId: 'C1' }) as never,
		);
		expect(res.status).toBe(503);
		expect(mockSaveEntries).not.toHaveBeenCalled();
	});

	it('add: 400 when any chapter id is invalid, nothing written', async () => {
		mockValidateChapter.mockImplementation(async (_tok: string, id: number) =>
			id === 2
				? { ok: false, error: 'Not a valid Solidarity chapter choice.', transient: false }
				: { ok: true, name: `Chapter ${id}` },
		);
		const res = await POST(
			makeEvent(authed, { action: 'add', chapterIds: [1, 2], channelId: 'C1' }) as never,
		);
		expect(res.status).toBe(400);
		expect(mockSaveEntries).not.toHaveBeenCalled();
	});

	it('remove: seeds then deletes the (chapter, channel) pairs in one call without live-list validation', async () => {
		const res = await POST(
			makeEvent(authed, { action: 'remove', chapterIds: [1, 2], channelId: 'C1' }) as never,
		);
		expect(res.status).toBe(200);
		expect(mockValidateChannel).not.toHaveBeenCalled();
		expect(mockValidateChapter).not.toHaveBeenCalled();
		expect(mockDeleteEntries).toHaveBeenCalledTimes(1);
		expect(mockDeleteEntries).toHaveBeenCalledWith(expect.anything(), [1, 2], 'C1', {
			id: 'U123',
			name: 'Alice',
		});
		expect(mockEnsureSeeded.mock.invocationCallOrder[0]).toBeLessThan(
			mockDeleteEntries.mock.invocationCallOrder[0]!,
		);
	});

	it('returns 400 for a non-JSON body', async () => {
		const event = {
			...authed,
			request: {
				json: async () => {
					throw new SyntaxError('bad');
				},
			} as unknown as Request,
		};
		const res = await POST(event as never);
		expect(res.status).toBe(400);
	});
});

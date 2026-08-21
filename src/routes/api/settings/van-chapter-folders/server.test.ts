import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockSave = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/settings', () => ({
	saveVanChapterFolders: mockSave,
	deleteVanChapterFolders: mockDelete,
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

const save = (over: Record<string, unknown> = {}) => ({
	action: 'save',
	chapterId: 71,
	chapterName: 'Middlesex County',
	folderIds: [1152, 1200],
	...over,
});

describe('POST /api/settings/van-chapter-folders', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSave.mockResolvedValue(undefined);
		mockDelete.mockResolvedValue(undefined);
	});

	it('returns 401 when not authenticated', async () => {
		const res = await POST(makeEvent(unauthed, save()) as never);
		expect(res.status).toBe(401);
		expect(mockSave).not.toHaveBeenCalled();
	});

	it('returns 403 when not admin', async () => {
		const res = await POST(makeEvent(nonAdmin, save()) as never);
		expect(res.status).toBe(403);
		expect(mockSave).not.toHaveBeenCalled();
	});

	it('saves a chapter’s folder list', async () => {
		const res = await POST(makeEvent(authed, save()) as never);
		expect(res.status).toBe(200);
		expect(mockSave).toHaveBeenCalledWith(
			{},
			{ chapterId: 71, chapterName: 'Middlesex County', folderIds: [1152, 1200] },
			{ id: 'U_ADMIN', name: 'Alice' },
		);
	});

	// An empty list is meaningful: "this chapter has no turf".
	it('accepts an empty folder list', async () => {
		const res = await POST(makeEvent(authed, save({ folderIds: [] })) as never);
		expect(res.status).toBe(200);
		expect(mockSave).toHaveBeenCalled();
	});

	it('removes a chapter mapping', async () => {
		const res = await POST(makeEvent(authed, { action: 'remove', chapterId: 71 }) as never);
		expect(res.status).toBe(200);
		expect(mockDelete).toHaveBeenCalledWith({}, 71, { id: 'U_ADMIN', name: 'Alice' });
	});

	it('rejects non-integer and non-positive ids', async () => {
		for (const body of [
			save({ chapterId: 'seventy-one' }),
			save({ chapterId: 0 }),
			save({ folderIds: [1152, -3] }),
			save({ folderIds: [1152, 1.5] }),
			save({ folderIds: ['1152'] }),
		]) {
			const res = await POST(makeEvent(authed, body) as never);
			expect(res.status).toBe(400);
		}
		expect(mockSave).not.toHaveBeenCalled();
	});

	it('rejects a missing chapter name and a non-array folder list', async () => {
		expect((await POST(makeEvent(authed, save({ chapterName: '  ' })) as never)).status).toBe(400);
		expect((await POST(makeEvent(authed, save({ folderIds: 1152 })) as never)).status).toBe(400);
	});

	it('caps how many folders one chapter can map to', async () => {
		const tooMany = Array.from({ length: 51 }, (_, i) => i + 1);
		const res = await POST(makeEvent(authed, save({ folderIds: tooMany })) as never);
		expect(res.status).toBe(400);
		expect(mockSave).not.toHaveBeenCalled();
	});

	it('rejects a bad action and malformed JSON', async () => {
		expect((await POST(makeEvent(authed, { action: 'nope', chapterId: 71 }) as never)).status).toBe(
			400,
		);
		const bad = {
			...authed,
			request: {
				json: async () => {
					throw new Error('bad json');
				},
			} as unknown as Request,
		};
		expect((await POST(bad as never)).status).toBe(400);
	});
});

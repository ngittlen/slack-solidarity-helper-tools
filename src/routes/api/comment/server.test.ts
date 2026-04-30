import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockUpdateWhere = vi.hoisted(() => vi.fn());
const mockSet = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockNotifyComment = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: { update: mockUpdate } }));
vi.mock('$lib/server/events', () => ({ notifyComment: mockNotifyComment }));

const authed = {
	locals: { session: { slackUserId: 'U123', slackUserName: 'Alice' } },
};
const unauthed = { locals: { session: null } };

function makeEvent(session: typeof authed | typeof unauthed, body: unknown) {
	return {
		...session,
		request: { json: async () => body } as Request,
	};
}

describe('POST /api/comment', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUpdate.mockReturnValue({ set: mockSet });
		mockSet.mockReturnValue({ where: mockUpdateWhere });
		mockUpdateWhere.mockResolvedValue(undefined);
	});

	it('redirects to /auth/slack when not authenticated', async () => {
		await expect(
			POST(makeEvent(unauthed, { id: 1, comment: 'hi' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/auth/slack' });
	});

	it('returns 400 when id is missing', async () => {
		const res = await POST(makeEvent(authed, { comment: 'hi' }) as never);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: expect.stringContaining('id') });
	});

	it('returns 400 when comment is not a string', async () => {
		const res = await POST(makeEvent(authed, { id: 1, comment: 42 }) as never);
		expect(res.status).toBe(400);
	});

	it('returns 400 when id is a string instead of number', async () => {
		const res = await POST(makeEvent(authed, { id: '1', comment: 'hi' }) as never);
		expect(res.status).toBe(400);
	});

	it('saves comment and returns success', async () => {
		const res = await POST(makeEvent(authed, { id: 5, comment: 'called' }) as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		expect(mockSet).toHaveBeenCalledWith(
			expect.objectContaining({ comment: 'called' }),
		);
	});

	it('stores null when comment is blank whitespace', async () => {
		await POST(makeEvent(authed, { id: 5, comment: '   ' }) as never);
		expect(mockSet).toHaveBeenCalledWith(
			expect.objectContaining({ comment: null }),
		);
	});

	it('saves the editor name and id', async () => {
		await POST(makeEvent(authed, { id: 5, comment: 'called' }) as never);
		expect(mockSet).toHaveBeenCalledWith(
			expect.objectContaining({ lastEditedById: 'U123', lastEditedByName: 'Alice' }),
		);
	});

	it('notifies subscribers after saving', async () => {
		await POST(makeEvent(authed, { id: 5, comment: 'called' }) as never);
		expect(mockNotifyComment).toHaveBeenCalledWith(5, 'called', 'Alice');
	});

	it('notifies with null when comment is blank', async () => {
		await POST(makeEvent(authed, { id: 5, comment: '   ' }) as never);
		expect(mockNotifyComment).toHaveBeenCalledWith(5, null, 'Alice');
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockUpdateWhere = vi.hoisted(() => vi.fn());
const mockSet = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockNotifyStatus = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: { update: mockUpdate } }));
vi.mock('$lib/server/events', () => ({ notifyStatus: mockNotifyStatus }));

const authed = {
	locals: { session: { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true } },
};
const unauthed = { locals: { session: null } };
const nonAdmin = {
	locals: { session: { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false } },
};
const legacySession = {
	locals: { session: { slackUserId: 'U999', slackUserName: 'Bob' } },
};

type EventInput = typeof authed | typeof unauthed | typeof nonAdmin | typeof legacySession;

function makeEvent(session: EventInput, body: unknown) {
	return { ...session, request: { json: async () => body } as Request };
}

describe('POST /api/helped', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUpdate.mockReturnValue({ set: mockSet });
		mockSet.mockReturnValue({ where: mockUpdateWhere });
		mockUpdateWhere.mockResolvedValue(undefined);
	});

	it('redirects to /auth/slack when not authenticated', async () => {
		await expect(
			POST(makeEvent(unauthed, { id: 1, status: 'verified_in_slack' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/auth/slack' });
	});

	it('returns 403 with body { error: "unauthorized" } when signed in but not admin', async () => {
		const res = await POST(makeEvent(nonAdmin, { id: 1, status: 'verified_in_slack' }) as never);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'unauthorized' });
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(mockNotifyStatus).not.toHaveBeenCalled();
	});

	it('returns 403 when session lacks isAdmin field (FR-008 defensive default)', async () => {
		const res = await POST(
			makeEvent(legacySession, { id: 1, status: 'verified_in_slack' }) as never,
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'unauthorized' });
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it('returns 400 when id is missing', async () => {
		await expect(
			POST(makeEvent(authed, { status: 'verified_in_slack' }) as never),
		).rejects.toMatchObject({ status: 400 });
	});

	it('returns 400 when status is not a valid value', async () => {
		await expect(
			POST(makeEvent(authed, { id: 1, status: 'invalid_status' }) as never),
		).rejects.toMatchObject({ status: 400 });
	});

	it('returns 400 when id is a string', async () => {
		await expect(
			POST(makeEvent(authed, { id: '1', status: 'verified_in_slack' }) as never),
		).rejects.toMatchObject({ status: 400 });
	});

	it('updates status and returns success', async () => {
		const res = await POST(makeEvent(authed, { id: 3, status: 'verified_in_slack' }) as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'verified_in_slack' }));
	});

	it('saves the editor name alongside the status', async () => {
		await POST(makeEvent(authed, { id: 3, status: 'contacted' }) as never);
		expect(mockSet).toHaveBeenCalledWith(
			expect.objectContaining({ lastEditedByName: 'Alice', lastEditedById: 'U123' }),
		);
	});

	it('notifies subscribers after update', async () => {
		await POST(makeEvent(authed, { id: 3, status: 'contacted' }) as never);
		expect(mockNotifyStatus).toHaveBeenCalledWith(3, 'contacted', 'Alice');
	});
});

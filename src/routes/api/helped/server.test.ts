import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockExecute = vi.hoisted(() => vi.fn());
const mockNotifyStatus = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: { execute: mockExecute } }));
vi.mock('$lib/server/events', () => ({ notifyStatus: mockNotifyStatus }));

// --- Helpers ---

const authed = {
	locals: { session: { slackUserId: 'U123', slackUserName: 'Alice' } },
};
const unauthed = { locals: { session: null } };

function makeEvent(session: typeof authed | typeof unauthed, body: unknown) {
	return { ...session, request: { json: async () => body } as Request };
}

// --- Tests ---

describe('POST /api/helped', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExecute.mockResolvedValue({});
	});

	it('redirects to /auth/slack when not authenticated', async () => {
		await expect(
			POST(makeEvent(unauthed, { id: 1, status: 'verified_in_slack' }) as never),
		).rejects.toMatchObject({ status: 302, location: '/auth/slack' });
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
		expect(mockExecute).toHaveBeenCalledWith(
			expect.objectContaining({ args: expect.arrayContaining(['verified_in_slack', 3]) }),
		);
	});

	it('saves the editor name alongside the status', async () => {
		await POST(makeEvent(authed, { id: 3, status: 'contacted' }) as never);
		expect(mockExecute).toHaveBeenCalledWith(
			expect.objectContaining({ args: expect.arrayContaining(['Alice', 'U123']) }),
		);
	});

	it('notifies subscribers after update', async () => {
		await POST(makeEvent(authed, { id: 3, status: 'contacted' }) as never);
		expect(mockNotifyStatus).toHaveBeenCalledWith(3, 'contacted', 'Alice');
	});
});
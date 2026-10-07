import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClear = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/outside-volunteers', () => ({ clearOutsideVolunteers: mockClear }));

import { POST } from './+server.js';

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true };
const MEMBER = { slackUserId: 'U_VOL', slackUserName: 'Bob', isAdmin: false };

function makeEvent(session: unknown, body: unknown) {
	return { locals: { session }, request: { json: async () => body } } as never;
}

describe('POST /api/settings/outside-volunteers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockClear.mockResolvedValue(3);
	});

	it('clears every record for an admin and says how many', async () => {
		const res = await POST(makeEvent(ADMIN, { action: 'clear' }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, cleared: 3 });
		expect(mockClear).toHaveBeenCalledTimes(1);
	});

	it('refuses anyone who is not signed in, or not an admin', async () => {
		expect((await POST(makeEvent(null, { action: 'clear' }))).status).toBe(401);
		expect((await POST(makeEvent(MEMBER, { action: 'clear' }))).status).toBe(403);
		expect(mockClear).not.toHaveBeenCalled();
	});

	it('refuses any other action', async () => {
		expect((await POST(makeEvent(ADMIN, { action: 'drop' }))).status).toBe(400);
		expect(mockClear).not.toHaveBeenCalled();
	});

	it('answers 500 when the delete fails', async () => {
		mockClear.mockRejectedValue(new Error('db down'));
		expect((await POST(makeEvent(ADMIN, { action: 'clear' }))).status).toBe(500);
	});
});

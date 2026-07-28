import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockSaveEntry = vi.hoisted(() => vi.fn());
const mockDeleteEntry = vi.hoisted(() => vi.fn());
const mockValidateChannel = vi.hoisted(() => vi.fn());
const mockValidateProperty = vi.hoisted(() => vi.fn());
const mockValidateUserList = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({ slack: {} }));
vi.mock('$lib/server/env', () => ({ SOLIDARITY_API_TOKEN: 'tok' }));
vi.mock('$lib/server/settings', () => ({
	saveCoalitionEntry: mockSaveEntry,
	deleteCoalitionEntry: mockDeleteEntry,
}));
vi.mock('$lib/server/settings-validation', () => ({
	validateSlackChannel: mockValidateChannel,
	validateSolidarityCustomProperty: mockValidateProperty,
	validateSolidarityUserList: mockValidateUserList,
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

describe('POST /api/settings/coalitions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSaveEntry.mockResolvedValue(undefined);
		mockDeleteEntry.mockResolvedValue(undefined);
		mockValidateChannel.mockResolvedValue({ ok: true, name: 'labor-coalition' });
		mockValidateProperty.mockResolvedValue({ ok: true, name: 'Labor Unions' });
		mockValidateUserList.mockResolvedValue({ ok: true, name: 'Labor coalition list' });
	});

	it('returns 401 when not authenticated and 403 when not admin', async () => {
		const body = { action: 'upsert', group: 'labor', channelId: 'C1', userListId: 42 };
		expect((await POST(makeEvent(unauthed, body) as never)).status).toBe(401);
		expect((await POST(makeEvent(nonAdmin, body) as never)).status).toBe(403);
		expect(mockSaveEntry).not.toHaveBeenCalled();
	});

	it('returns 400 for unknown action or blank group', async () => {
		for (const body of [
			{ action: 'rename', group: 'labor', channelId: 'C1' },
			{ action: 'upsert', group: '', channelId: 'C1' },
			{ action: 'upsert', channelId: 'C1' },
		]) {
			expect((await POST(makeEvent(authed, body) as never)).status).toBe(400);
		}
	});

	it('upsert: validates property, channel, and list, then saves with the property display name', async () => {
		const res = await POST(
			makeEvent(authed, {
				action: 'upsert',
				group: 'labor',
				channelId: 'C1',
				userListId: 42,
			}) as never,
		);
		expect(res.status).toBe(200);

		expect(mockValidateProperty).toHaveBeenCalledWith('tok', 'labor');
		expect(mockValidateChannel).toHaveBeenCalledWith(expect.anything(), 'C1');
		expect(mockValidateUserList).toHaveBeenCalledWith('tok', 42);
		expect(mockSaveEntry).toHaveBeenCalledWith(
			expect.anything(),
			{ group: 'labor', channelId: 'C1', name: 'Labor Unions', userListId: 42 },
			{ id: 'U123', name: 'Alice' },
		);
	});

	it('upsert: allows a null/omitted userListId without validating the list', async () => {
		const res = await POST(
			makeEvent(authed, { action: 'upsert', group: 'labor', channelId: 'C1' }) as never,
		);
		expect(res.status).toBe(200);
		expect(mockValidateUserList).not.toHaveBeenCalled();
		expect(mockSaveEntry).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ userListId: null }),
			expect.anything(),
		);
	});

	it('upsert: 400 for a non-integer userListId', async () => {
		const res = await POST(
			makeEvent(authed, {
				action: 'upsert',
				group: 'labor',
				channelId: 'C1',
				userListId: 'forty-two',
			}) as never,
		);
		expect(res.status).toBe(400);
		expect(mockSaveEntry).not.toHaveBeenCalled();
	});

	it('upsert: invalid property → 400, transient channel outage → 503, nothing written', async () => {
		mockValidateProperty.mockResolvedValueOnce({ ok: false, error: 'bad', transient: false });
		let res = await POST(
			makeEvent(authed, { action: 'upsert', group: 'ghosts', channelId: 'C1' }) as never,
		);
		expect(res.status).toBe(400);

		mockValidateChannel.mockResolvedValueOnce({ ok: false, error: 'down', transient: true });
		res = await POST(
			makeEvent(authed, { action: 'upsert', group: 'labor', channelId: 'C1' }) as never,
		);
		expect(res.status).toBe(503);

		expect(mockSaveEntry).not.toHaveBeenCalled();
	});

	it('delete: deletes without live-list validation', async () => {
		const res = await POST(makeEvent(authed, { action: 'delete', group: 'labor' }) as never);
		expect(res.status).toBe(200);
		expect(mockValidateProperty).not.toHaveBeenCalled();
		expect(mockDeleteEntry).toHaveBeenCalledWith(expect.anything(), 'labor', {
			id: 'U123',
			name: 'Alice',
		});
	});
});

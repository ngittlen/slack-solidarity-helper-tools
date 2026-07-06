import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockEnsureSeeded = vi.hoisted(() => vi.fn());
const mockSaveUser = vi.hoisted(() => vi.fn());
const mockDeleteUser = vi.hoisted(() => vi.fn());
const mockValidateUser = vi.hoisted(() => vi.fn());
const mockGetSlackUsers = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({ slack: {} }));
vi.mock('$lib/server/env', () => ({ SLACK_SUPERUSER_ID: 'USUPER' }));
vi.mock('$lib/server/autocomplete-sources', () => ({ getSlackUsers: mockGetSlackUsers }));
vi.mock('$lib/server/settings', () => ({
	ensureAllowedUsersSeeded: mockEnsureSeeded,
	saveAllowedUser: mockSaveUser,
	deleteAllowedUser: mockDeleteUser,
}));
vi.mock('$lib/server/settings-validation', () => ({
	validateSlackUser: mockValidateUser,
}));

const authed = {
	locals: { session: { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true } },
};
const superuserSession = {
	locals: { session: { slackUserId: 'USUPER', slackUserName: 'Root', isAdmin: true } },
};
const unauthed = { locals: { session: null } };
const nonAdmin = {
	locals: { session: { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false } },
};

function makeEvent(
	session: typeof authed | typeof unauthed | typeof nonAdmin | typeof superuserSession,
	body: unknown,
) {
	return {
		...session,
		request: { json: async () => body } as Request,
	};
}

describe('POST /api/settings/allowed-users', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockEnsureSeeded.mockResolvedValue(undefined);
		mockSaveUser.mockResolvedValue(undefined);
		mockDeleteUser.mockResolvedValue(undefined);
		mockValidateUser.mockResolvedValue({ ok: true, displayName: 'Dana' });
		mockGetSlackUsers.mockResolvedValue({
			items: [{ id: 'UDANA', name: 'Dana', realName: 'Dana D.' }],
			stale: false,
			fetchedAt: 0,
		});
	});

	it('returns 401 when not authenticated', async () => {
		const res = await POST(makeEvent(unauthed, { action: 'add', userId: 'UDANA' }) as never);
		expect(res.status).toBe(401);
		expect(mockSaveUser).not.toHaveBeenCalled();
	});

	it('returns 403 when not admin', async () => {
		const res = await POST(makeEvent(nonAdmin, { action: 'add', userId: 'UDANA' }) as never);
		expect(res.status).toBe(403);
		expect(mockSaveUser).not.toHaveBeenCalled();
	});

	it('returns 400 for an unknown action and for a missing/blank userId', async () => {
		for (const body of [
			{ action: 'toggle', userId: 'UDANA' },
			{ action: 'add', userId: '' },
			{ action: 'add', userId: '   ' },
			{ action: 'add', userId: 7 },
			{ action: 'add' },
		]) {
			const res = await POST(makeEvent(authed, body) as never);
			expect(res.status).toBe(400);
		}
		expect(mockSaveUser).not.toHaveBeenCalled();
		expect(mockDeleteUser).not.toHaveBeenCalled();
	});

	it('add: validates, seeds with display names, then saves the validated name', async () => {
		const res = await POST(makeEvent(authed, { action: 'add', userId: 'UDANA' }) as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		expect(mockValidateUser).toHaveBeenCalledWith(expect.anything(), 'UDANA');
		expect(mockEnsureSeeded).toHaveBeenCalledWith(expect.anything(), new Map([['UDANA', 'Dana']]));
		expect(mockSaveUser).toHaveBeenCalledWith(
			expect.anything(),
			{ slackUserId: 'UDANA', displayName: 'Dana' },
			{ id: 'U123', name: 'Alice' },
		);
		expect(mockEnsureSeeded.mock.invocationCallOrder[0]).toBeLessThan(
			mockSaveUser.mock.invocationCallOrder[0]!,
		);
	});

	it('add: 400 for an unknown user id, nothing written', async () => {
		mockValidateUser.mockResolvedValue({
			ok: false,
			error: 'Not a valid Slack user choice.',
			transient: false,
		});
		const res = await POST(makeEvent(authed, { action: 'add', userId: 'UNOPE' }) as never);
		expect(res.status).toBe(400);
		expect(mockSaveUser).not.toHaveBeenCalled();
		expect(mockEnsureSeeded).not.toHaveBeenCalled();
	});

	it('add: 503 when the user list is transiently unavailable', async () => {
		mockValidateUser.mockResolvedValue({ ok: false, error: 'unavailable', transient: true });
		const res = await POST(makeEvent(authed, { action: 'add', userId: 'UDANA' }) as never);
		expect(res.status).toBe(503);
		expect(mockSaveUser).not.toHaveBeenCalled();
	});

	it('add: a getSlackUsers failure only costs the seed names, not the write', async () => {
		mockGetSlackUsers.mockRejectedValue(new Error('slack down'));
		const res = await POST(makeEvent(authed, { action: 'add', userId: 'UDANA' }) as never);
		expect(res.status).toBe(200);
		expect(mockEnsureSeeded).toHaveBeenCalledWith(expect.anything(), undefined);
		expect(mockSaveUser).toHaveBeenCalledTimes(1);
	});

	it('remove: seeds then deletes without live-list validation', async () => {
		const res = await POST(makeEvent(authed, { action: 'remove', userId: 'UDANA' }) as never);
		expect(res.status).toBe(200);
		expect(mockValidateUser).not.toHaveBeenCalled();
		expect(mockDeleteUser).toHaveBeenCalledWith(expect.anything(), 'UDANA', {
			id: 'U123',
			name: 'Alice',
		});
		expect(mockEnsureSeeded.mock.invocationCallOrder[0]).toBeLessThan(
			mockDeleteUser.mock.invocationCallOrder[0]!,
		);
	});

	it('remove: refuses to remove your own id', async () => {
		const res = await POST(makeEvent(authed, { action: 'remove', userId: 'U123' }) as never);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/your own admin access/);
		expect(mockDeleteUser).not.toHaveBeenCalled();
	});

	it('remove: the superuser may remove their own id (they stay admin via env)', async () => {
		const res = await POST(
			makeEvent(superuserSession, { action: 'remove', userId: 'USUPER' }) as never,
		);
		expect(res.status).toBe(200);
		expect(mockDeleteUser).toHaveBeenCalledWith(expect.anything(), 'USUPER', {
			id: 'USUPER',
			name: 'Root',
		});
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

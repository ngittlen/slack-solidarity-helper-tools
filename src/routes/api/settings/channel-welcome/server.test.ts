import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockSetFlag = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/settings', () => ({ setChannelWelcomeFlag: mockSetFlag }));

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

describe('POST /api/settings/channel-welcome', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSetFlag.mockResolvedValue(undefined);
	});

	it('401 / 403 gates', async () => {
		expect(
			(await POST(makeEvent(unauthed, { channelId: 'C1', showWelcome: false }) as never)).status,
		).toBe(401);
		expect(
			(await POST(makeEvent(nonAdmin, { channelId: 'C1', showWelcome: false }) as never)).status,
		).toBe(403);
		expect(mockSetFlag).not.toHaveBeenCalled();
	});

	it('400 for a missing/blank channelId or non-boolean showWelcome', async () => {
		for (const body of [
			{ showWelcome: true },
			{ channelId: '', showWelcome: true },
			{ channelId: '  ', showWelcome: true },
			{ channelId: 7, showWelcome: true },
			{ channelId: 'C1' },
			{ channelId: 'C1', showWelcome: 'yes' },
		]) {
			const res = await POST(makeEvent(authed, body) as never);
			expect(res.status).toBe(400);
		}
		expect(mockSetFlag).not.toHaveBeenCalled();
	});

	it('saves the flag with the session editor', async () => {
		const res = await POST(
			makeEvent(authed, { channelId: 'C_QUIET', showWelcome: false }) as never,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(mockSetFlag).toHaveBeenCalledWith(expect.anything(), 'C_QUIET', false, {
			id: 'U123',
			name: 'Alice',
		});
	});

	it('400 for a non-JSON body', async () => {
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

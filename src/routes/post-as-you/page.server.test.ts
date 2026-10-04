import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadUserToken = vi.hoisted(() => vi.fn());
const mockDeleteUserToken = vi.hoisted(() => vi.fn());
const mockRevoke = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/user-tokens', () => ({
	loadUserToken: mockLoadUserToken,
	deleteUserToken: mockDeleteUserToken,
	revokeUserToken: mockRevoke,
}));

import { load, actions } from './+page.server.js';

type Session = App.Locals['session'];

const ADMIN: Session = { slackUserId: 'UADMIN', slackUserName: 'A', isAdmin: true };
const MOD: Session = { slackUserId: 'UMOD', slackUserName: 'M', isAdmin: false, isModerator: true };
const MEMBER: Session = { slackUserId: 'UMEM', slackUserName: 'V', isAdmin: false };

function event(session: Session) {
	return { locals: { session } } as never;
}

describe('/post-as-you', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDeleteUserToken.mockResolvedValue(undefined);
		mockRevoke.mockResolvedValue(true);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	describe('load', () => {
		it('reports on when a usable token is stored', async () => {
			mockLoadUserToken.mockResolvedValue({ ok: true, token: 'xoxp' });

			expect(await load(event(ADMIN))).toEqual({ pageTitle: 'Post as you', enabled: true });
		});

		it('reports off for a pre-chat:write row, like the commands would', async () => {
			mockLoadUserToken.mockResolvedValue({ ok: false, reason: 'stale-scope' });

			expect(await load(event(MOD))).toMatchObject({ enabled: false });
		});

		it('sends anyone else home', async () => {
			await expect(load(event(MEMBER))).rejects.toMatchObject({ status: 302, location: '/' });
			await expect(load(event(null))).rejects.toMatchObject({ status: 302, location: '/' });
		});
	});

	describe('turnOff', () => {
		it('deletes the token here, then revokes it at Slack, and says both happened', async () => {
			mockLoadUserToken.mockResolvedValue({ ok: true, token: 'xoxp-real' });

			expect(await actions.turnOff(event(ADMIN))).toEqual({ turnedOff: true, revoked: true });

			expect(mockDeleteUserToken).toHaveBeenCalledWith(expect.anything(), 'UADMIN');
			expect(mockRevoke).toHaveBeenCalledWith('xoxp-real', 'UADMIN');
			// Order matters: a failed delete must leave nothing half-done.
			expect(mockDeleteUserToken.mock.invocationCallOrder[0]).toBeLessThan(
				mockRevoke.mock.invocationCallOrder[0]!,
			);
		});

		it("reports it when Slack doesn't confirm the revoke", async () => {
			mockLoadUserToken.mockResolvedValue({ ok: true, token: 'xoxp-real' });
			mockRevoke.mockResolvedValue(false);

			expect(await actions.turnOff(event(ADMIN))).toEqual({ turnedOff: true, revoked: false });
			expect(mockDeleteUserToken).toHaveBeenCalledWith(expect.anything(), 'UADMIN');
		});

		it('deletes an unreadable row, and does not claim Slack revoked it', async () => {
			mockLoadUserToken.mockResolvedValue({ ok: false, reason: 'unreadable' });

			expect(await actions.turnOff(event(MOD))).toEqual({ turnedOff: true, revoked: false });
			expect(mockRevoke).not.toHaveBeenCalled();
			expect(mockDeleteUserToken).toHaveBeenCalledWith(expect.anything(), 'UMOD');
		});

		it('changes nothing, and says so, when the delete fails', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			mockLoadUserToken.mockResolvedValue({ ok: true, token: 'xoxp-real' });
			mockDeleteUserToken.mockRejectedValue(new Error('db down'));

			expect(await actions.turnOff(event(ADMIN))).toMatchObject({
				status: 500,
				data: { error: expect.stringContaining('try again') },
			});
			expect(mockRevoke).not.toHaveBeenCalled();
		});

		it('refuses anyone else', async () => {
			await expect(actions.turnOff(event(MEMBER))).rejects.toMatchObject({ status: 302 });
			expect(mockDeleteUserToken).not.toHaveBeenCalled();
		});
	});
});

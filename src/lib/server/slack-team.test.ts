import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./slack.js', () => ({ slack: {} }));

import { resetWorkspaceTeamId, workspaceTeamId } from './slack-team.js';

describe('workspaceTeamId', () => {
	beforeEach(() => {
		resetWorkspaceTeamId();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns the bot token’s workspace, and asks Slack only once', async () => {
		const authTest = vi.fn(async () => ({ ok: true, team_id: 'T0123ABCD' }));
		expect(await workspaceTeamId(authTest)).toBe('T0123ABCD');
		expect(await workspaceTeamId(authTest)).toBe('T0123ABCD');
		expect(authTest).toHaveBeenCalledTimes(1);
	});

	it('gives up quietly when Slack fails, and asks again next time', async () => {
		const failing = vi.fn(async () => {
			throw new Error('invalid_auth');
		});
		expect(await workspaceTeamId(failing)).toBeNull();
		const working = vi.fn(async () => ({ ok: true, team_id: 'T0123ABCD' }));
		expect(await workspaceTeamId(working)).toBe('T0123ABCD');
	});

	it('does not hold up sign-in when Slack is slow', async () => {
		vi.useFakeTimers();
		const never = vi.fn(() => new Promise<{ ok: boolean }>(() => {}));
		const pending = workspaceTeamId(never);
		await vi.advanceTimersByTimeAsync(2000);
		expect(await pending).toBeNull();
	});

	it('ignores an answer that is not a workspace id', async () => {
		expect(await workspaceTeamId(async () => ({ ok: false }))).toBeNull();
		expect(await workspaceTeamId(async () => ({ ok: true, team_id: 'not-an-id' }))).toBeNull();
	});
});

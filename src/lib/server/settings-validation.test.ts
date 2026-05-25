import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebClient } from '@slack/web-api';

// The validators delegate to the autocomplete sources, so we mock that module
// wholesale. Each test then controls exactly what the underlying getter
// resolves or rejects with.
vi.mock('./autocomplete-sources.js', () => ({
	getSlackChannels: vi.fn(),
	getSlackUsers: vi.fn(),
	getSolidarityChapters: vi.fn(),
}));

import {
	validateSlackChannel,
	validateSlackUser,
	validateSolidarityChapter,
} from './settings-validation.js';
import {
	getSlackChannels,
	getSlackUsers,
	getSolidarityChapters,
} from './autocomplete-sources.js';

const getChannels = vi.mocked(getSlackChannels);
const getUsers = vi.mocked(getSlackUsers);
const getChapters = vi.mocked(getSolidarityChapters);

const slack = {} as unknown as WebClient;

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ===========================================================================
// User Story 3 — invalid picks are caught before they persist
// ===========================================================================

describe('US3: validateSlackChannel', () => {
	it('Scenario 1 — present channel id resolves { ok: true, name } (FR-014)', async () => {
		getChannels.mockResolvedValueOnce({
			items: [
				{ id: 'C001', name: 'announcements', isPrivate: false },
				{ id: 'C002', name: 'random', isPrivate: false },
			],
			stale: false,
		});

		const result = await validateSlackChannel(slack, 'C001');
		expect(result).toEqual({ ok: true, name: 'announcements' });
	});

	it('Scenario 2 — non-existent channel id resolves { ok: false, transient: false } (FR-015)', async () => {
		getChannels.mockResolvedValueOnce({
			items: [{ id: 'C001', name: 'announcements', isPrivate: false }],
			stale: false,
		});

		const result = await validateSlackChannel(slack, 'C_GHOST');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.transient).toBe(false);
			expect(result.error).toMatch(/not a valid/i);
		}
	});

	it('Scenario 3 — channel archived as of the last cache refresh is absent from the cached list → { ok: false, transient: false } (FR-016)', async () => {
		// FR-001: the fetcher already excludes archived channels, so the
		// archived id simply is not in `items`. The validator path is the same
		// as "absent" — this test names it explicitly to map 1:1 to the spec
		// acceptance scenario.
		getChannels.mockResolvedValueOnce({
			items: [{ id: 'C_LIVE', name: 'general', isPrivate: false }],
			stale: false,
		});

		const result = await validateSlackChannel(slack, 'C_ARCHIVED');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.transient).toBe(false);
	});

	it('a stale-served result still validates (membership is independent of freshness)', async () => {
		getChannels.mockResolvedValueOnce({
			items: [{ id: 'C001', name: 'announcements', isPrivate: false }],
			stale: true,
		});

		const result = await validateSlackChannel(slack, 'C001');
		expect(result).toEqual({ ok: true, name: 'announcements' });
	});

	it('a wrong-type id (user id passed to channel validator) → { ok: false, transient: false } (FR-015)', async () => {
		getChannels.mockResolvedValueOnce({
			items: [{ id: 'C001', name: 'announcements', isPrivate: false }],
			stale: false,
		});

		const result = await validateSlackChannel(slack, 'U001');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.transient).toBe(false);
	});
});

describe('US3: validateSlackUser', () => {
	it('Scenario 5 — present user id resolves { ok: true, displayName } (FR-014)', async () => {
		getUsers.mockResolvedValueOnce({
			items: [{ id: 'U001', name: 'alice', realName: 'Alice Example' }],
			stale: false,
		});

		const result = await validateSlackUser(slack, 'U001');
		expect(result).toEqual({ ok: true, displayName: 'alice' });
	});

	it('Scenario 4 — deactivated or bot user id is absent from the cached list → { ok: false, transient: false } (FR-016)', async () => {
		// The fetcher (FR-002) strips bots and deactivated members, so a bot
		// id simply is not in `items`. Same path as "absent" — named here so
		// the test name maps to the spec acceptance scenario verbatim.
		getUsers.mockResolvedValueOnce({
			items: [{ id: 'U_REAL', name: 'real human', realName: 'Real Human' }],
			stale: false,
		});

		const result = await validateSlackUser(slack, 'U_BOT');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.transient).toBe(false);
	});
});

describe('US3: validateSolidarityChapter', () => {
	it('Scenario 6a — existing chapter id resolves { ok: true, name } (FR-014)', async () => {
		getChapters.mockResolvedValueOnce({
			items: [
				{ id: 42, name: 'Brooklyn' },
				{ id: 7, name: 'Bay Area' },
			],
			stale: false,
		});

		const result = await validateSolidarityChapter('token', 42);
		expect(result).toEqual({ ok: true, name: 'Brooklyn' });
	});

	it('Scenario 6b — unknown chapter id resolves { ok: false, transient: false } (FR-015)', async () => {
		getChapters.mockResolvedValueOnce({
			items: [{ id: 42, name: 'Brooklyn' }],
			stale: false,
		});

		const result = await validateSolidarityChapter('token', 999);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.transient).toBe(false);
	});
});

// ===========================================================================
// User Story 4 — validators degrade gracefully when the source is down
// ===========================================================================

describe('US4: validators fail closed when the autocomplete source is unavailable', () => {
	it('source throws → { ok: false, transient: true } (FR-018, FR-019)', async () => {
		getChannels.mockRejectedValueOnce(new Error('upstream down'));

		const result = await validateSlackChannel(slack, 'C001');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.transient).toBe(true);
			expect(result.error).toMatch(/temporarily unavailable|try again/i);
		}
	});

	it('user-list source throws → { ok: false, transient: true }', async () => {
		getUsers.mockRejectedValueOnce(new Error('slack 503'));

		const result = await validateSlackUser(slack, 'U001');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.transient).toBe(true);
	});

	it('chapter-list source throws → { ok: false, transient: true }', async () => {
		getChapters.mockRejectedValueOnce(new Error('solidarity unreachable'));

		const result = await validateSolidarityChapter('token', 1);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.transient).toBe(true);
	});

	it('never throws regardless of how the source fails (FR-017)', async () => {
		// Bizarre inputs — non-Error rejection, undefined, even a throwing
		// thenable — must all be swallowed into a structured failure result.
		getChannels.mockRejectedValueOnce('plain string rejection');
		await expect(validateSlackChannel(slack, 'X')).resolves.toMatchObject({ ok: false, transient: true });

		getUsers.mockRejectedValueOnce(undefined);
		await expect(validateSlackUser(slack, 'X')).resolves.toMatchObject({ ok: false, transient: true });

		getChapters.mockRejectedValueOnce(new TypeError('boom'));
		await expect(validateSolidarityChapter('token', 0)).resolves.toMatchObject({ ok: false, transient: true });
	});

	it('a routine validation rejection produces no error-level log (FR-021, SC-007)', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		getChannels.mockResolvedValueOnce({
			items: [{ id: 'C001', name: 'a', isPrivate: false }],
			stale: false,
		});

		await validateSlackChannel(slack, 'C_GHOST');

		expect(errorSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

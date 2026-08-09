import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveMember, type MemberLookupDeps } from './member-lookup.js';
import type { MemberNoteRow } from './schema.js';

const SLACK_USER = {
	id: 'U_TARGET',
	name: 'jordan',
	realName: 'Jordan Rivera',
	email: 'jordan@example.org',
};

const feedOk = { ok: true as const, items: [], totalCount: null, truncated: false };

function makeDeps(over: Partial<MemberLookupDeps> = {}): MemberLookupDeps {
	return {
		findSlackUser: vi.fn().mockResolvedValue(SLACK_USER),
		findLink: vi.fn().mockResolvedValue(null),
		findByEmail: vi.fn().mockResolvedValue({ id: 500 }),
		fetchActions: vi.fn().mockResolvedValue(feedOk),
		fetchRsvps: vi.fn().mockResolvedValue(feedOk),
		fetchChapters: vi.fn().mockResolvedValue(['Detroit']),
		listNotes: vi.fn().mockResolvedValue([] as MemberNoteRow[]),
		...over,
	};
}

beforeEach(() => vi.clearAllMocks());

describe('resolveMember', () => {
	it('returns null when the Slack id is not a directory member', async () => {
		const deps = makeDeps({ findSlackUser: vi.fn().mockResolvedValue(null) });
		expect(await resolveMember(deps, 'U_GONE')).toBeNull();
	});

	it('matches by email when there is no manual link', async () => {
		const deps = makeDeps();

		const result = await resolveMember(deps, 'U_TARGET');

		expect(result!.link).toEqual({ reason: 'email', solidarityUserId: 500 });
		expect(deps.findByEmail).toHaveBeenCalledWith('jordan@example.org');
	});

	// A manual link is an explicit human decision about a case the email
	// heuristic already got wrong; it must not be second-guessed.
	it('prefers a manual link over the email match', async () => {
		const deps = makeDeps({
			findLink: vi.fn().mockResolvedValue({
				solidarityUserId: 900,
				linkedByName: 'Admin Person',
				linkedAt: '2026-01-01T00:00:00Z',
			}),
		});

		const result = await resolveMember(deps, 'U_TARGET');

		expect(result!.link).toMatchObject({ reason: 'linked', solidarityUserId: 900 });
		expect(deps.findByEmail).not.toHaveBeenCalled();
		expect(deps.fetchActions).toHaveBeenCalledWith(900);
	});

	it('reports no-slack-email when the directory has no address', async () => {
		const deps = makeDeps({
			findSlackUser: vi.fn().mockResolvedValue({ ...SLACK_USER, email: '' }),
		});

		const result = await resolveMember(deps, 'U_TARGET');

		expect(result!.link).toEqual({ reason: 'no-slack-email', solidarityUserId: null });
		expect(deps.findByEmail).not.toHaveBeenCalled();
	});

	it('reports no-solidarity-match when the email has no account', async () => {
		const deps = makeDeps({ findByEmail: vi.fn().mockResolvedValue(null) });

		const result = await resolveMember(deps, 'U_TARGET');

		expect(result!.link).toEqual({ reason: 'no-solidarity-match', solidarityUserId: null });
	});

	// Distinct from no-solidarity-match on purpose — the page must not invite a
	// hand-link just because Solidarity was briefly unreachable.
	it('distinguishes a failed lookup from a genuine non-match', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const deps = makeDeps({ findByEmail: vi.fn().mockRejectedValue(new Error('503')) });

		const result = await resolveMember(deps, 'U_TARGET');

		expect(result!.link).toEqual({ reason: 'lookup-failed', solidarityUserId: null });
	});

	it('skips both feeds when there is no Solidarity account', async () => {
		const deps = makeDeps({ findByEmail: vi.fn().mockResolvedValue(null) });

		const result = await resolveMember(deps, 'U_TARGET');

		expect(deps.fetchActions).not.toHaveBeenCalled();
		expect(result!.actions.ok).toBe(false);
		expect(result!.rsvps.ok).toBe(false);
	});

	it('fetches both feeds when an account is resolved', async () => {
		const deps = makeDeps();

		const result = await resolveMember(deps, 'U_TARGET');

		expect(deps.fetchActions).toHaveBeenCalledWith(500);
		expect(deps.fetchRsvps).toHaveBeenCalledWith(500);
		expect(result!.actions.ok).toBe(true);
		expect(result!.rsvps.ok).toBe(true);
	});

	it('degrades one failing feed without taking down the other', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const deps = makeDeps({ fetchRsvps: vi.fn().mockRejectedValue(new Error('boom')) });

		const result = await resolveMember(deps, 'U_TARGET');

		expect(result!.actions.ok).toBe(true);
		expect(result!.rsvps.ok).toBe(false);
	});

	// Warning history is the one thing that must survive any upstream outage.
	it('still returns notes when Solidarity is entirely unavailable', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const notes = [{ id: 1 }] as unknown as MemberNoteRow[];
		const deps = makeDeps({
			findByEmail: vi.fn().mockRejectedValue(new Error('down')),
			listNotes: vi.fn().mockResolvedValue(notes),
		});

		const result = await resolveMember(deps, 'U_TARGET');

		expect(result!.notes).toHaveLength(1);
		expect(result!.link.reason).toBe('lookup-failed');
	});

	it('survives a notes read failure with an empty list', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const deps = makeDeps({ listNotes: vi.fn().mockRejectedValue(new Error('db down')) });

		const result = await resolveMember(deps, 'U_TARGET');

		expect(result!.notes).toEqual([]);
	});

	it('falls back to the email path when the link read fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const deps = makeDeps({ findLink: vi.fn().mockRejectedValue(new Error('db down')) });

		const result = await resolveMember(deps, 'U_TARGET');

		expect(result!.link.reason).toBe('email');
	});

	it('carries the Slack summary through', async () => {
		const result = await resolveMember(makeDeps(), 'U_TARGET');
		expect(result!.slack).toEqual(SLACK_USER);
	});

	it('returns the chapters of a resolved account', async () => {
		const deps = makeDeps({ fetchChapters: vi.fn().mockResolvedValue(['Ann Arbor', 'Detroit']) });

		const result = await resolveMember(deps, 'U_TARGET');

		expect(deps.fetchChapters).toHaveBeenCalledWith(500);
		expect(result!.chapters).toEqual(['Ann Arbor', 'Detroit']);
	});

	it('has no chapters when there is no Solidarity account', async () => {
		const deps = makeDeps({ findByEmail: vi.fn().mockResolvedValue(null) });

		const result = await resolveMember(deps, 'U_TARGET');

		expect(deps.fetchChapters).not.toHaveBeenCalled();
		expect(result!.chapters).toEqual([]);
	});

	// The chapter line is context on the header — losing it must not cost the
	// admin the activity and notes they actually came for.
	it('degrades a failed chapter lookup to no chapters, leaving the feeds intact', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const deps = makeDeps({ fetchChapters: vi.fn().mockRejectedValue(new Error('503')) });

		const result = await resolveMember(deps, 'U_TARGET');

		expect(result!.chapters).toEqual([]);
		expect(result!.actions.ok).toBe(true);
		expect(result!.rsvps.ok).toBe(true);
	});
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
	getSlackChannels,
	getSlackUsers,
	getSolidarityChapters,
	_resetAutocompleteCachesForTests,
} from './autocomplete-sources.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface SlackMockResponse {
	channels?: unknown[];
	members?: unknown[];
	response_metadata?: { next_cursor?: string };
}

function makeSlack(): {
	slack: WebClient;
	conversationsList: ReturnType<typeof vi.fn>;
	usersList: ReturnType<typeof vi.fn>;
} {
	const conversationsList = vi.fn<(args: unknown) => Promise<SlackMockResponse>>();
	const usersList = vi.fn<(args: unknown) => Promise<SlackMockResponse>>();
	const slack = {
		conversations: { list: conversationsList },
		users: { list: usersList },
	} as unknown as WebClient;
	return { slack, conversationsList, usersList };
}

function chaptersPage(items: { id: number; name: string }[]) {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => ({ data: items }),
		text: async () => '',
	} as unknown as Response;
}

// ---------------------------------------------------------------------------
// Shared setup — each test starts with a cold cache and clean mocks.
// ---------------------------------------------------------------------------

beforeEach(() => {
	_resetAutocompleteCachesForTests();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ===========================================================================
// User Story 1 — pickers offer real, current choices
// ===========================================================================

describe('US1: getSlackChannels', () => {
	it('maps Slack channels to ChannelEntry, sorted ascending by name, excluding archived (FR-001, FR-005, FR-006)', async () => {
		const { slack, conversationsList } = makeSlack();
		// `exclude_archived: true` is passed as a request param, so the upstream
		// returns only non-archived rows in the first place — assert via the
		// request shape that the param was set.
		conversationsList.mockResolvedValueOnce({
			channels: [
				{ id: 'C002', name: 'beta', is_private: false },
				{ id: 'C001', name: 'alpha', is_private: true },
			],
		});

		const result = await getSlackChannels(slack);

		expect(conversationsList).toHaveBeenCalledTimes(1);
		expect(conversationsList).toHaveBeenCalledWith(
			expect.objectContaining({
				types: 'public_channel,private_channel',
				exclude_archived: true,
				limit: 1000,
			}),
		);
		expect(result.stale).toBe(false);
		expect(result.items).toEqual([
			{ id: 'C001', name: 'alpha', isPrivate: true },
			{ id: 'C002', name: 'beta', isPrivate: false },
		]);
	});

	it('walks every cursor page until next_cursor is empty (FR-004)', async () => {
		const { slack, conversationsList } = makeSlack();
		conversationsList
			.mockResolvedValueOnce({
				channels: [{ id: 'C1', name: 'a', is_private: false }],
				response_metadata: { next_cursor: 'page2' },
			})
			.mockResolvedValueOnce({
				channels: [{ id: 'C2', name: 'b', is_private: false }],
				response_metadata: { next_cursor: '' },
			});

		const result = await getSlackChannels(slack);

		expect(conversationsList).toHaveBeenCalledTimes(2);
		expect(conversationsList.mock.calls[1]?.[0]).toMatchObject({ cursor: 'page2' });
		expect(result.items.map((c) => c.id)).toEqual(['C1', 'C2']);
	});
});

describe('US1: getSlackUsers', () => {
	it('excludes bots and deactivated users, resolves display name, sorts (FR-002, FR-005)', async () => {
		const { slack, usersList } = makeSlack();
		usersList.mockResolvedValueOnce({
			members: [
				{
					id: 'U_BOT',
					is_bot: true,
					profile: { display_name: 'Bot', real_name: 'Bot Account' },
				},
				{
					id: 'U_DELETED',
					deleted: true,
					profile: { display_name: 'Ghost', real_name: 'Ghost User' },
				},
				{
					id: 'U_BETA',
					name: 'beta_handle',
					profile: { display_name: '', real_name: 'Zeta Real' },
				},
				{
					id: 'U_ALPHA',
					name: 'alpha_handle',
					profile: { display_name: 'alpha display', real_name: 'Alpha Real' },
				},
				{
					id: 'U_GAMMA',
					name: 'gamma_handle',
					profile: { display_name: '', real_name: '' },
				},
			],
		});

		const result = await getSlackUsers(slack);

		expect(result.stale).toBe(false);
		// alpha display → from display_name; Zeta Real → from real_name fallback;
		// gamma_handle → from name fallback (display & real both empty). Bots and
		// deleted users are dropped entirely. Sort is by resolved display name.
		expect(result.items).toEqual([
			{ id: 'U_ALPHA', name: 'alpha display', realName: 'Alpha Real' },
			{ id: 'U_GAMMA', name: 'gamma_handle', realName: '' },
			{ id: 'U_BETA', name: 'Zeta Real', realName: 'Zeta Real' },
		]);
	});

	it('paginates users.list via cursor (FR-004)', async () => {
		const { slack, usersList } = makeSlack();
		usersList
			.mockResolvedValueOnce({
				members: [{ id: 'U1', name: 'a', profile: { display_name: 'a', real_name: 'A' } }],
				response_metadata: { next_cursor: 'next' },
			})
			.mockResolvedValueOnce({
				members: [{ id: 'U2', name: 'b', profile: { display_name: 'b', real_name: 'B' } }],
				response_metadata: { next_cursor: '' },
			});

		const result = await getSlackUsers(slack);

		expect(usersList).toHaveBeenCalledTimes(2);
		expect(usersList.mock.calls[1]?.[0]).toMatchObject({ cursor: 'next' });
		expect(result.items.map((u) => u.id)).toEqual(['U1', 'U2']);
	});
});

describe('US1: getSolidarityChapters', () => {
	it('returns mapped, sorted chapter entries (FR-003, FR-005, FR-006)', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			chaptersPage([
				{ id: 2, name: 'Beta' },
				{ id: 1, name: 'Alpha' },
			]),
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await getSolidarityChapters('token');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stale).toBe(false);
		expect(result.items).toEqual([
			{ id: 1, name: 'Alpha' },
			{ id: 2, name: 'Beta' },
		]);
	});

	it('paginates /v1/chapters by offset until a short page is returned (FR-004)', async () => {
		const fullPage = Array.from({ length: 100 }, (_, i) => ({
			id: i + 1,
			name: `chapter-${String(i + 1).padStart(3, '0')}`,
		}));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(chaptersPage(fullPage))
			.mockResolvedValueOnce(chaptersPage([{ id: 200, name: 'chapter-200' }]));
		vi.stubGlobal('fetch', fetchMock);

		const result = await getSolidarityChapters('token');

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.items).toHaveLength(101);
	});
});

// ===========================================================================
// User Story 2 — lists stay fast without going stale
// ===========================================================================

describe('US2: cache + force + de-dup', () => {
	it('warm call within the 5-minute TTL hits cache, not the API (FR-007, SC-002)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-23T12:00:00Z'));
		const { slack, conversationsList } = makeSlack();
		conversationsList.mockResolvedValue({
			channels: [{ id: 'C1', name: 'a', is_private: false }],
		});

		const first = await getSlackChannels(slack);
		expect(conversationsList).toHaveBeenCalledTimes(1);

		// Advance 4 minutes — still inside the TTL window.
		vi.advanceTimersByTime(4 * 60 * 1000);
		const second = await getSlackChannels(slack);

		expect(conversationsList).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
		expect(second.stale).toBe(false);
	});

	it('refetches after the TTL elapses (FR-008)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-23T12:00:00Z'));
		const { slack, conversationsList } = makeSlack();
		conversationsList
			.mockResolvedValueOnce({ channels: [{ id: 'C1', name: 'a', is_private: false }] })
			.mockResolvedValueOnce({ channels: [{ id: 'C2', name: 'b', is_private: false }] });

		await getSlackChannels(slack);
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);
		const second = await getSlackChannels(slack);

		expect(conversationsList).toHaveBeenCalledTimes(2);
		expect(second.items[0]?.id).toBe('C2');
	});

	it('force: true bypasses a fresh cache and replaces it (FR-009)', async () => {
		const { slack, conversationsList } = makeSlack();
		conversationsList
			.mockResolvedValueOnce({ channels: [{ id: 'C1', name: 'a', is_private: false }] })
			.mockResolvedValueOnce({ channels: [{ id: 'C2', name: 'b', is_private: false }] });

		await getSlackChannels(slack);
		const forced = await getSlackChannels(slack, { force: true });

		expect(conversationsList).toHaveBeenCalledTimes(2);
		expect(forced.items[0]?.id).toBe('C2');
		expect(forced.stale).toBe(false);

		// The forced result replaces the cache: a subsequent warm read returns it.
		const warm = await getSlackChannels(slack);
		expect(conversationsList).toHaveBeenCalledTimes(2);
		expect(warm.items[0]?.id).toBe('C2');
	});

	it('an empty upstream response is cached normally; second call hits the cache (edge case: empty workspace)', async () => {
		const { slack, conversationsList } = makeSlack();
		conversationsList.mockResolvedValueOnce({ channels: [] });

		const first = await getSlackChannels(slack);
		expect(first).toEqual({ items: [], stale: false });
		expect(conversationsList).toHaveBeenCalledTimes(1);

		const second = await getSlackChannels(slack);
		expect(second).toEqual({ items: [], stale: false });
		expect(conversationsList).toHaveBeenCalledTimes(1);
	});

	it('two concurrent cold callers share one upstream fetch (FR-007a, SC-002)', async () => {
		const { slack, conversationsList } = makeSlack();
		let resolveFetch!: (v: SlackMockResponse) => void;
		const pending = new Promise<SlackMockResponse>((r) => {
			resolveFetch = r;
		});
		conversationsList.mockReturnValueOnce(pending);

		const p1 = getSlackChannels(slack);
		const p2 = getSlackChannels(slack);

		// Both started before the upstream call resolves — only one call issued.
		expect(conversationsList).toHaveBeenCalledTimes(1);

		resolveFetch({ channels: [{ id: 'C1', name: 'shared', is_private: false }] });
		const [a, b] = await Promise.all([p1, p2]);

		expect(conversationsList).toHaveBeenCalledTimes(1);
		expect(a).toEqual(b);
		expect(a.items[0]?.id).toBe('C1');
	});
});

// ===========================================================================
// User Story 4 — upstream outages degrade gracefully
// ===========================================================================

describe('US4: failure handling and stale-serve', () => {
	it('expired cache + failing refetch → resolves { stale: true } with the retained items (FR-010a)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-23T12:00:00Z'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { slack, conversationsList } = makeSlack();
		conversationsList
			.mockResolvedValueOnce({ channels: [{ id: 'C1', name: 'a', is_private: false }] })
			.mockRejectedValueOnce(new Error('slack 503'))
			.mockResolvedValueOnce({ channels: [{ id: 'C2', name: 'b', is_private: false }] });

		await getSlackChannels(slack);
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);

		const stale = await getSlackChannels(slack);
		expect(stale.stale).toBe(true);
		expect(stale.items[0]?.id).toBe('C1');
		expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[autocomplete\] channels refetch failed/));

		// The entry was NOT updated, so the next call retries the upstream and
		// — when it succeeds — replaces the cache (FR-010a final clause).
		const recovered = await getSlackChannels(slack);
		expect(conversationsList).toHaveBeenCalledTimes(3);
		expect(recovered.stale).toBe(false);
		expect(recovered.items[0]?.id).toBe('C2');
	});

	it('cold cache + fetch fails → rejects, logs at error level (FR-011)', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { slack, conversationsList } = makeSlack();
		conversationsList.mockRejectedValueOnce(new Error('slack unreachable'));

		await expect(getSlackChannels(slack)).rejects.toThrow(/slack unreachable/);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringMatching(/^\[autocomplete\] channels fetch failed \(no cached data\)/),
		);
	});

	it('Solidarity retry-budget exhaustion surfaces as a fetch failure (FR-004a)', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {}); // mute the per-retry [autocomplete] warn
		const rateLimited = {
			ok: false,
			status: 429,
			headers: new Headers({ 'Retry-After': '0' }),
			json: async () => ({}),
			text: async () => 'rate limited',
		} as unknown as Response;
		// 6 consecutive 429s — first hit plus 5 retries — exhausts the budget.
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(rateLimited)
			.mockResolvedValueOnce(rateLimited)
			.mockResolvedValueOnce(rateLimited)
			.mockResolvedValueOnce(rateLimited)
			.mockResolvedValueOnce(rateLimited)
			.mockResolvedValueOnce(rateLimited);
		vi.stubGlobal('fetch', fetchMock);

		await expect(getSolidarityChapters('token')).rejects.toThrow(/retry budget exhausted/);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringMatching(/^\[autocomplete\] chapters fetch failed/),
		);
	});
});

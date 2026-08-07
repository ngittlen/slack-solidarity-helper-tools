import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './+server.js';

const mockGetSolidarityMembers = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/autocomplete-sources', () => ({
	getSolidarityMembers: mockGetSolidarityMembers,
}));
vi.mock('$lib/server/env', () => ({ SOLIDARITY_API_TOKEN: 'tok' }));

const adminSession = { slackUserId: 'U_ADMIN', slackUserName: 'Admin', isAdmin: true };

function call(q: string, session: unknown = adminSession) {
	return GET({
		url: new URL(`http://localhost/api/members/solidarity-search?q=${encodeURIComponent(q)}`),
		locals: { session },
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetSolidarityMembers.mockResolvedValue({
		items: [
			{ id: 1, name: 'Jordan Rivera', email: 'jordan@example.org', otherEmails: [] },
			{ id: 2, name: 'Sam Okafor', email: 'sam@example.org', otherEmails: ['s.okafor@work.test'] },
		],
		stale: false,
		fetchedAt: 1_700_000_000_000,
		refreshing: false,
	});
});

describe('auth', () => {
	it('401s with no session', async () => {
		expect((await call('jordan', null)).status).toBe(401);
	});

	it('403s for a non-admin', async () => {
		expect((await call('jordan', { ...adminSession, isAdmin: false })).status).toBe(403);
	});
});

describe('query handling', () => {
	it.each(['', ' ', 'a', ' a '])('400s for too-short query %p', async (q) => {
		const res = await call(q);
		expect(res.status).toBe(400);
		expect(mockGetSolidarityMembers).not.toHaveBeenCalled();
	});

	it('returns matches for a valid query', async () => {
		const res = await call('jordan');

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.items).toEqual([{ id: 1, label: 'Jordan Rivera', sublabel: 'jordan@example.org' }]);
	});

	it('matches an alternate email and reports the one that matched', async () => {
		const body = await (await call('s.okafor')).json();
		expect(body.items).toEqual([{ id: 2, label: 'Sam Okafor', sublabel: 's.okafor@work.test' }]);
	});

	it('returns an empty list rather than an error when nothing matches', async () => {
		const res = await call('zzzznope');
		expect(res.status).toBe(200);
		expect((await res.json()).items).toEqual([]);
	});

	it('passes through the cache freshness flags', async () => {
		mockGetSolidarityMembers.mockResolvedValue({
			items: [],
			stale: true,
			fetchedAt: 12345,
			refreshing: false,
		});

		const body = await (await call('jordan')).json();

		expect(body).toMatchObject({ stale: true, fetchedAt: 12345, refreshing: false });
	});

	it('always asks for stale-while-revalidate so the request never waits on a walk', async () => {
		await call('jordan');

		expect(mockGetSolidarityMembers).toHaveBeenCalledWith(
			'tok',
			expect.objectContaining({ staleWhileRevalidate: true }),
		);
	});
});

describe('background refresh', () => {
	// Replaces the old 503 path: with stale-while-revalidate the roster call
	// never rejects, so a cold cache is reported rather than errored.
	it('reports a first-time build instead of failing or returning "no matches"', async () => {
		mockGetSolidarityMembers.mockResolvedValue({
			items: [],
			stale: false,
			fetchedAt: 0,
			refreshing: true,
		});

		const res = await call('jordan');
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toMatchObject({ items: [], refreshing: true, firstFetch: true });
	});

	it('serves the previous list while a refresh runs, without flagging a first fetch', async () => {
		mockGetSolidarityMembers.mockResolvedValue({
			items: [{ id: 1, name: 'Jordan Rivera', email: 'jordan@example.org', otherEmails: [] }],
			stale: false,
			fetchedAt: 1_700_000_000_000,
			refreshing: true,
		});

		const body = await (await call('jordan')).json();

		expect(body.items).toHaveLength(1);
		expect(body).toMatchObject({ refreshing: true, firstFetch: false });
	});

	it('normalizes a missing refreshing flag to false', async () => {
		mockGetSolidarityMembers.mockResolvedValue({ items: [], stale: false, fetchedAt: 1 });

		const body = await (await call('jordan')).json();

		expect(body).toMatchObject({ refreshing: false, firstFetch: false });
	});
});

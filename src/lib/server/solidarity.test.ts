import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// The activity fetchers resolve page names and event titles from these cached
// lists before hitting their own endpoint; stubbed so the fetch mock below only
// ever sees the activity request under test.
const mockGetSolidarityPages = vi.hoisted(() => vi.fn());
const mockGetSolidarityEvents = vi.hoisted(() => vi.fn());
const mockGetSolidarityChapters = vi.hoisted(() => vi.fn());
vi.mock('./autocomplete-sources.js', () => ({
	getSolidarityPages: mockGetSolidarityPages,
	getSolidarityEvents: mockGetSolidarityEvents,
	getSolidarityChapters: mockGetSolidarityChapters,
}));

import {
	findUserByEmailStrict,
	setUserCustomProperty,
	getRecentUserActions,
	getRecentEventRsvps,
	getUserChapterNames,
	_resetShapeLogForTests,
} from './solidarity.js';

function rateLimited(retryAfter = '0') {
	return {
		ok: false,
		status: 429,
		headers: new Headers({ 'Retry-After': retryAfter }),
		json: async () => ({}),
		text: async () => 'rate limited',
	} as unknown as Response;
}

function found(id: number) {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => ({ data: [{ id, chapter_id: null, chapter_ids: [], address: null }] }),
	} as unknown as Response;
}

function updated() {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		text: async () => '',
	} as unknown as Response;
}

describe('findUserByEmailStrict', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('retries on 429 honoring Retry-After, then returns the match', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock.mockResolvedValueOnce(rateLimited('0')).mockResolvedValueOnce(found(42));

		const user = await findUserByEmailStrict('token', 'a@example.org');

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(user?.id).toBe(42);
	});

	it('throws once the retry budget is exhausted (6 consecutive 429s)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'));

		await expect(findUserByEmailStrict('token', 'a@example.org')).rejects.toThrow(
			/retry budget exhausted/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it('keeps retry budgets independent across concurrent lookups', async () => {
		// Mirrors coalition-reconcile.ts's mapPool: several lookups in flight at
		// once, each with its own fetchWithRetry budget. One retries once and
		// succeeds, one exhausts its own budget and throws, one never retries —
		// none of that should be visible to (or borrowed from) the others.
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const callCounts = new Map<string, number>();
		fetchMock.mockImplementation(async (url) => {
			const email = new URL(url as string).searchParams.get('email') ?? '';
			const n = (callCounts.get(email) ?? 0) + 1;
			callCounts.set(email, n);
			if (email === 'retries-once@example.org') return n === 1 ? rateLimited('0') : found(1);
			if (email === 'exhausts@example.org') return rateLimited('0');
			if (email === 'clean@example.org') return found(3);
			throw new Error(`unexpected email in test: ${email}`);
		});

		const [retriesOnce, exhausts, clean] = await Promise.allSettled([
			findUserByEmailStrict('token', 'retries-once@example.org'),
			findUserByEmailStrict('token', 'exhausts@example.org'),
			findUserByEmailStrict('token', 'clean@example.org'),
		]);

		expect(retriesOnce.status).toBe('fulfilled');
		expect(retriesOnce.status === 'fulfilled' && retriesOnce.value?.id).toBe(1);
		expect(exhausts.status).toBe('rejected');
		expect(exhausts.status === 'rejected' && exhausts.reason.message).toMatch(
			/retry budget exhausted/,
		);
		expect(clean.status).toBe('fulfilled');
		expect(clean.status === 'fulfilled' && clean.value?.id).toBe(3);

		// One retry (2 calls), a full exhausted budget (6 calls), and a clean
		// single call (1 call) — each count only reflects its own lookup.
		expect(callCounts.get('retries-once@example.org')).toBe(2);
		expect(callCounts.get('exhausts@example.org')).toBe(6);
		expect(callCounts.get('clean@example.org')).toBe(1);
	});
});

describe('setUserCustomProperty', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('retries on 429 honoring Retry-After, then succeeds', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock.mockResolvedValueOnce(rateLimited('0')).mockResolvedValueOnce(updated());

		await expect(
			setUserCustomProperty('token', 42, 'in_coalition_x', 'true'),
		).resolves.toBeUndefined();

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('throws once the retry budget is exhausted (6 consecutive 429s)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'));

		await expect(setUserCustomProperty('token', 42, 'in_coalition_x', 'true')).rejects.toThrow(
			/retry budget exhausted/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});
});

// ---------------------------------------------------------------------------
// Member activity feeds
// ---------------------------------------------------------------------------

function activityPage(data: unknown[], totalCount?: number) {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => ({
			data,
			...(totalCount === undefined ? {} : { meta: { total_count: totalCount } }),
		}),
		text: async () => '',
	} as unknown as Response;
}

describe('getRecentUserActions / getRecentEventRsvps', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		_resetShapeLogForTests();
		mockGetSolidarityPages.mockResolvedValue({ items: [{ id: 5597, name: 'Join Us' }] });
		mockGetSolidarityEvents.mockResolvedValue({ items: [{ id: 28588, name: 'Watch Party' }] });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('requests user_actions filtered by user_id, a full page at offset 0', async () => {
		fetchMock.mockResolvedValueOnce(activityPage([]));

		await getRecentUserActions('tok', 42);

		const url = fetchMock.mock.calls[0]![0] as string;
		expect(url).toContain('/v1/user_actions?');
		expect(url).toContain('user_id=42');
		// A full page, not _limit=5 — the API's sort order is undocumented, so
		// asking for 5 could return the five oldest rows.
		expect(url).toContain('_limit=100');
		expect(url).toContain('_offset=0');
	});

	it('requests event_rsvps with full_user_payload=false', async () => {
		fetchMock.mockResolvedValueOnce(activityPage([]));

		await getRecentEventRsvps('tok', 42);

		const url = fetchMock.mock.calls[0]![0] as string;
		expect(url).toContain('/v1/event_rsvps?');
		expect(url).toContain('user_id=42');
		// The alternative embeds the member's whole personal record in each row.
		expect(url).toContain('full_user_payload=false');
	});

	it('sends the bearer token', async () => {
		fetchMock.mockResolvedValueOnce(activityPage([]));

		await getRecentUserActions('secret-token', 1);

		expect(fetchMock.mock.calls[0]![1]).toMatchObject({
			headers: { Authorization: 'Bearer secret-token' },
		});
	});

	it('normalizes, sorts newest-first, and limits to five', async () => {
		fetchMock.mockResolvedValueOnce(
			activityPage([
				{ id: 1, title: 'oldest', created_at: '2026-01-01T00:00:00Z' },
				{ id: 2, title: 'newest', created_at: '2026-06-01T00:00:00Z' },
				{ id: 3, title: 'middle', created_at: '2026-03-01T00:00:00Z' },
			]),
		);

		const feed = await getRecentUserActions('tok', 1);

		expect(feed.items.map((i) => i.title)).toEqual(['newest', 'middle', 'oldest']);
	});

	it('honors an explicit limit', async () => {
		fetchMock.mockResolvedValueOnce(
			activityPage(Array.from({ length: 20 }, (_, i) => ({ id: i, title: `t${i}` }))),
		);

		expect((await getRecentUserActions('tok', 1, 2)).items).toHaveLength(2);
	});

	it('reports total_count when the API provides it', async () => {
		fetchMock.mockResolvedValueOnce(activityPage([{ id: 1, title: 'x' }], 37));

		expect((await getRecentUserActions('tok', 1)).totalCount).toBe(37);
	});

	it('reports a null total_count when the API omits it', async () => {
		fetchMock.mockResolvedValueOnce(activityPage([{ id: 1, title: 'x' }]));

		expect((await getRecentUserActions('tok', 1)).totalCount).toBeNull();
	});

	it('flags truncated when a full page comes back', async () => {
		fetchMock.mockResolvedValueOnce(
			activityPage(Array.from({ length: 100 }, (_, i) => ({ id: i, title: `t${i}` }))),
		);

		expect((await getRecentUserActions('tok', 1)).truncated).toBe(true);
	});

	it('does not flag truncated on a short page', async () => {
		fetchMock.mockResolvedValueOnce(activityPage([{ id: 1, title: 'x' }]));

		expect((await getRecentUserActions('tok', 1)).truncated).toBe(false);
	});

	it('tolerates a missing or non-array data field', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({}),
		} as unknown as Response);

		expect((await getRecentUserActions('tok', 1)).items).toEqual([]);
	});

	it('throws on a non-2xx so the page can degrade that section only', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 500,
			headers: new Headers(),
			json: async () => ({}),
			text: async () => 'boom',
		} as unknown as Response);

		await expect(getRecentUserActions('tok', 1)).rejects.toThrow('user_actions returned 500');
	});

	it('retries a 429 within its own budget', async () => {
		fetchMock
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(activityPage([{ id: 1, title: 'x' }]));

		const feed = await getRecentUserActions('tok', 1);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(feed.items).toHaveLength(1);
	});

	it('logs the response key names once per endpoint, never the values', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		fetchMock.mockResolvedValue(activityPage([{ id: 1, title: 'Signed', secret_field: 'PII' }]));

		await getRecentUserActions('tok', 1);
		await getRecentUserActions('tok', 2);

		const lines = logSpy.mock.calls.map((c) => String(c[0]));
		const shapeLines = lines.filter((l) => l.includes('sample keys'));
		expect(shapeLines).toHaveLength(1);
		expect(shapeLines[0]).toContain('id, title, secret_field');
		expect(shapeLines[0]).not.toContain('PII');
	});

	// Both endpoints return one row per occurrence, so a member who committed to
	// six weeks of the same event would otherwise fill the whole feed with it.
	it('collapses repeat RSVPs for one event, freeing slots for other events', async () => {
		mockGetSolidarityEvents.mockResolvedValue({
			items: [
				{ id: 10, name: 'Weekly Canvass' },
				{ id: 20, name: 'Watch Party' },
			],
		});
		fetchMock.mockResolvedValueOnce(
			activityPage([
				...Array.from({ length: 6 }, (_, i) => ({
					id: i,
					event_id: 10,
					event_session_id: 100 + i,
					created_at: `2026-03-0${i + 1}T00:00:00Z`,
				})),
				{ id: 99, event_id: 20, event_session_id: 200, created_at: '2026-02-01T00:00:00Z' },
			]),
		);

		const feed = await getRecentEventRsvps('tok', 1);

		expect(feed.items.map((i) => [i.title, i.count])).toEqual([
			['Weekly Canvass', 6],
			['Watch Party', 1],
		]);
	});

	it('collapses repeat submissions of one action page', async () => {
		mockGetSolidarityPages.mockResolvedValue({ items: [{ id: 5597, name: 'Join Us' }] });
		fetchMock.mockResolvedValueOnce(
			activityPage([
				{ id: 1, action_page_id: 5597, created_at: '2026-01-01T00:00:00Z' },
				{ id: 2, action_page_id: 5597, created_at: '2026-01-08T00:00:00Z' },
			]),
		);

		const feed = await getRecentUserActions('tok', 1);

		expect(feed.items).toHaveLength(1);
		expect(feed.items[0]).toMatchObject({ title: 'Join Us', count: 2 });
	});
});

describe('getUserChapterNames', () => {
	const fetchMock = vi.fn();

	function userPage(body: unknown, status = 200) {
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: new Headers(),
			json: async () => body,
			text: async () => '',
		} as unknown as Response;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
		mockGetSolidarityChapters.mockResolvedValue({
			items: [
				{ id: 1, name: 'Detroit' },
				{ id: 2, name: 'Ann Arbor' },
			],
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('names every chapter the member belongs to, alphabetically', async () => {
		fetchMock.mockResolvedValueOnce(
			userPage({ data: { id: 42, chapter_id: 1, chapter_ids: [1, 2] } }),
		);

		expect(await getUserChapterNames('tok', 42)).toEqual(['Ann Arbor', 'Detroit']);
		expect(fetchMock.mock.calls[0]![0]).toContain('/v1/users/42');
	});

	// The by-id envelope is unpublished; all three observed shapes are accepted.
	it('reads a bare user object and a data array as well as data object', async () => {
		fetchMock.mockResolvedValueOnce(userPage({ id: 42, chapter_id: null, chapter_ids: [2] }));
		expect(await getUserChapterNames('tok', 42)).toEqual(['Ann Arbor']);

		fetchMock.mockResolvedValueOnce(
			userPage({ data: [{ id: 42, chapter_id: null, chapter_ids: [1] }] }),
		);
		expect(await getUserChapterNames('tok', 42)).toEqual(['Detroit']);
	});

	it('folds the singular chapter_id in without duplicating it', async () => {
		fetchMock.mockResolvedValueOnce(
			userPage({ data: { id: 42, chapter_id: 1, chapter_ids: [1] } }),
		);
		expect(await getUserChapterNames('tok', 42)).toEqual(['Detroit']);
	});

	// Better than showing nothing: the admin still learns they're in a chapter.
	it('falls back to the id when the chapter list has no name for it', async () => {
		fetchMock.mockResolvedValueOnce(userPage({ data: { id: 42, chapter_ids: [77] } }));
		expect(await getUserChapterNames('tok', 42)).toEqual(['Chapter 77']);
	});

	it('returns [] for a member in no chapters', async () => {
		fetchMock.mockResolvedValueOnce(
			userPage({ data: { id: 42, chapter_id: null, chapter_ids: [] } }),
		);
		expect(await getUserChapterNames('tok', 42)).toEqual([]);
	});

	it('returns [] rather than throwing when the user is gone', async () => {
		fetchMock.mockResolvedValueOnce(userPage({}, 404));
		expect(await getUserChapterNames('tok', 42)).toEqual([]);
	});

	// Throws so resolveMember logs it; the header just loses its chapter line.
	it('throws on any other non-2xx', async () => {
		fetchMock.mockResolvedValueOnce(userPage({}, 500));
		await expect(getUserChapterNames('tok', 42)).rejects.toThrow('returned 500');
	});

	it('still names what it can when the chapter list is unavailable', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockGetSolidarityChapters.mockRejectedValue(new Error('down'));
		fetchMock.mockResolvedValueOnce(userPage({ data: { id: 42, chapter_ids: [1] } }));

		expect(await getUserChapterNames('tok', 42)).toEqual(['Chapter 1']);
	});
});

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockFilters = vi.hoisted(() => vi.fn());
const mockPage = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('../activity-page.js', () => ({
	activityFilters: mockFilters,
	loadActivityPage: mockPage,
}));

const { GET } = await import('./+server.js');

const ADMIN = { slackUserId: 'U_ADMIN', isAdmin: true };
const QUERY = {
	chapterId: 71,
	campaignId: 2,
	range: { start: '2026-08-23T18:00:00.000Z', end: '2026-08-24T18:00:00.000Z' },
	search: 'kent',
};
const CURSOR = 'before=2026-08-24T10:00:00.000Z&after=5:claimed&now=2026-08-24T18:00:00.000Z';

const event = (session: unknown, query = CURSOR) =>
	({
		locals: { session },
		url: new URL(`https://app.example/turfs/activity/more?${query}`),
	}) as never;

beforeEach(() => {
	vi.clearAllMocks();
	mockFilters.mockResolvedValue({ query: QUERY });
	mockPage.mockResolvedValue({ events: [], dayLabels: {}, hasMore: false });
});

describe('GET /turfs/activity/more', () => {
	it('returns 401 when not signed in', async () => {
		expect((await GET(event(null))).status).toBe(401);
	});

	it('returns 403 for a signed-in non-admin, reading nothing', async () => {
		expect((await GET(event({ slackUserId: 'U1', isAdmin: false }))).status).toBe(403);
		expect(mockPage).not.toHaveBeenCalled();
	});

	it.each([
		['no cursor', 'now=2026-08-24T18:00:00.000Z'],
		['a junk time', 'before=banana&after=5:claimed&now=2026-08-24T18:00:00.000Z'],
		['a junk id', 'before=2026-08-24T10:00:00.000Z&after=x&now=2026-08-24T18:00:00.000Z'],
		['no now', 'before=2026-08-24T10:00:00.000Z&after=5:claimed'],
	])('rejects %s', async (_label, query) => {
		expect((await GET(event(ADMIN, query))).status).toBe(400);
		expect(mockPage).not.toHaveBeenCalled();
	});

	it('loads the page after the cursor, filtered and measured like the page', async () => {
		const res = await GET(event(ADMIN, `${CURSOR}&chapter=71&campaign=2&days=1&q=kent`));
		expect(await res.json()).toEqual({ events: [], dayLabels: {}, hasMore: false });
		const now = new Date('2026-08-24T18:00:00.000Z');
		// The filters are read off the same URL, against the page's own now.
		expect(mockFilters).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ search: expect.stringContaining('q=kent') }),
			now,
		);
		expect(mockPage).toHaveBeenCalledWith(expect.anything(), QUERY, now, {
			after: { at: '2026-08-24T10:00:00.000Z', checkoutId: 5, id: '5:claimed' },
		});
	});
});

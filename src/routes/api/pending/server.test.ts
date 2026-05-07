import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, _resetSlackEmailCache } from './+server.js';

const mockOrderBy = vi.hoisted(() => vi.fn());
const mockSelectFrom = vi.hoisted(() => vi.fn());
const mockSelect = vi.hoisted(() => vi.fn());
const mockUsersList = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: { select: mockSelect } }));
vi.mock('$lib/server/slack', () => ({ slack: { users: { list: mockUsersList } } }));

const authed = { locals: { session: { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true } } };
const unauthed = { locals: { session: null } };
const nonAdmin = { locals: { session: { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false } } };
const legacySession = { locals: { session: { slackUserId: 'U999', slackUserName: 'Bob' } } };

function row(overrides: object = {}) {
	return {
		id: 1,
		email: 'a@example.com',
		name: 'Alice',
		phone: null,
		comment: null,
		status: 'uncontacted',
		lastEditedById: null,
		lastEditedByName: null,
		...overrides,
	};
}

function slackPage(emails: string[], nextCursor = '') {
	return {
		members: emails.map((email) => ({ deleted: false, is_bot: false, profile: { email } })),
		response_metadata: { next_cursor: nextCursor },
	};
}

describe('GET /api/pending', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetSlackEmailCache();
		mockSelect.mockReturnValue({ from: mockSelectFrom });
		mockSelectFrom.mockReturnValue({ orderBy: mockOrderBy });
		mockOrderBy.mockResolvedValue([]);
		mockUsersList.mockResolvedValue(slackPage([]));
	});

	it('redirects to /auth/slack when not authenticated', async () => {
		await expect(GET(unauthed as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/slack',
		});
	});

	it('returns 403 with body { error: "unauthorized" } when signed in but not admin', async () => {
		const res = await GET(nonAdmin as never);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'unauthorized' });
		expect(mockSelect).not.toHaveBeenCalled();
	});

	it('returns 403 when session lacks isAdmin field (FR-008 defensive default)', async () => {
		const res = await GET(legacySession as never);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'unauthorized' });
		expect(mockSelect).not.toHaveBeenCalled();
	});

	it('returns empty result when there are no requests', async () => {
		const res = await GET(authed as never);
		expect(await res.json()).toEqual({ pending: [], total_requested: 0, total_pending: 0 });
	});

	it('includes all rows and sets total counts', async () => {
		mockOrderBy.mockResolvedValue([row(), row({ id: 2, email: 'b@example.com' })]);
		const json = await (await GET(authed as never)).json();
		expect(json.total_requested).toBe(2);
		expect(json.total_pending).toBe(2);
	});

	it('sets in_slack true for emails present in Slack', async () => {
		mockOrderBy.mockResolvedValue([row({ email: 'a@example.com' })]);
		mockUsersList.mockResolvedValue(slackPage(['a@example.com']));
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].in_slack).toBe(true);
	});

	it('sets in_slack false for emails not in Slack', async () => {
		mockOrderBy.mockResolvedValue([row()]);
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].in_slack).toBe(false);
	});

	it('in_slack is false for phone-only rows', async () => {
		mockOrderBy.mockResolvedValue([row({ email: null, phone: '555-1234' })]);
		mockUsersList.mockResolvedValue(slackPage(['anyone@example.com']));
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].in_slack).toBe(false);
	});

	it('email comparison is case-insensitive', async () => {
		mockOrderBy.mockResolvedValue([row({ email: 'User@Example.COM' })]);
		mockUsersList.mockResolvedValue(slackPage(['user@example.com']));
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].in_slack).toBe(true);
	});

	it('excludes verified_in_slack rows from total_pending', async () => {
		mockOrderBy.mockResolvedValue([row({ id: 1 }), row({ id: 2, status: 'verified_in_slack' })]);
		const json = await (await GET(authed as never)).json();
		expect(json.total_requested).toBe(2);
		expect(json.total_pending).toBe(1);
	});

	it('returns status as a string', async () => {
		mockOrderBy.mockResolvedValue([row({ status: 'contacted' })]);
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].status).toBe('contacted');
	});

	it('returns lastEditedByName from the database', async () => {
		mockOrderBy.mockResolvedValue([row({ lastEditedByName: 'Alice', lastEditedById: 'U123' })]);
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].lastEditedByName).toBe('Alice');
		expect(json.pending[0].lastEditedById).toBe('U123');
	});

	it('returns null lastEditedByName when row has never been edited', async () => {
		mockOrderBy.mockResolvedValue([row()]);
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].lastEditedByName).toBeNull();
	});

	it('caches Slack member emails across requests within the TTL', async () => {
		mockOrderBy.mockResolvedValue([row()]);
		await GET(authed as never);
		await GET(authed as never);
		expect(mockUsersList).toHaveBeenCalledTimes(1);
	});

	it('paginates through Slack member pages using cursor', async () => {
		mockOrderBy.mockResolvedValue([row()]);
		mockUsersList
			.mockResolvedValueOnce(slackPage(['page1@example.com'], 'cursor1'))
			.mockResolvedValueOnce(slackPage(['page2@example.com'], ''));
		await GET(authed as never);
		expect(mockUsersList).toHaveBeenCalledTimes(2);
		expect(mockUsersList).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ cursor: 'cursor1' }),
		);
	});
});

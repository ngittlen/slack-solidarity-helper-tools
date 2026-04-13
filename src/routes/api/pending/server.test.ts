import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './+server.js';

const mockExecute = vi.hoisted(() => vi.fn());
const mockUsersList = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: { execute: mockExecute } }));
vi.mock('$lib/server/slack', () => ({ slack: { users: { list: mockUsersList } } }));

// --- Helpers ---

const authed = { locals: { session: { slackUserId: 'U123' } } };
const unauthed = { locals: { session: null } };

function row(overrides: object = {}) {
	return {
		id: 1,
		email: 'a@example.com',
		name: 'Alice',
		phone: null,
		comment: null,
		status: 'uncontacted',
		last_edited_by_id: null,
		last_edited_by_name: null,
		...overrides,
	};
}

function slackPage(emails: string[], nextCursor = '') {
	return {
		members: emails.map((email) => ({ deleted: false, is_bot: false, profile: { email } })),
		response_metadata: { next_cursor: nextCursor },
	};
}

// --- Tests ---

describe('GET /api/pending', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUsersList.mockResolvedValue(slackPage([]));
	});

	it('redirects to /auth/slack when not authenticated', async () => {
		await expect(GET(unauthed as never)).rejects.toMatchObject({
			status: 302,
			location: '/auth/slack',
		});
	});

	it('returns empty result when there are no requests', async () => {
		mockExecute.mockResolvedValue({ rows: [] });
		const res = await GET(authed as never);
		expect(await res.json()).toEqual({ pending: [], total_requested: 0, total_pending: 0 });
	});

	it('includes all rows and sets total counts', async () => {
		mockExecute.mockResolvedValue({ rows: [row(), row({ id: 2, email: 'b@example.com' })] });
		const json = await (await GET(authed as never)).json();
		expect(json.total_requested).toBe(2);
		expect(json.total_pending).toBe(2);
	});

	it('sets in_slack true for emails present in Slack', async () => {
		mockExecute.mockResolvedValue({ rows: [row({ email: 'a@example.com' })] });
		mockUsersList.mockResolvedValue(slackPage(['a@example.com']));
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].in_slack).toBe(true);
	});

	it('sets in_slack false for emails not in Slack', async () => {
		mockExecute.mockResolvedValue({ rows: [row()] });
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].in_slack).toBe(false);
	});

	it('in_slack is false for phone-only rows', async () => {
		mockExecute.mockResolvedValue({ rows: [row({ email: null, phone: '555-1234' })] });
		mockUsersList.mockResolvedValue(slackPage(['anyone@example.com']));
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].in_slack).toBe(false);
	});

	it('email comparison is case-insensitive', async () => {
		mockExecute.mockResolvedValue({ rows: [row({ email: 'User@Example.COM' })] });
		mockUsersList.mockResolvedValue(slackPage(['user@example.com']));
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].in_slack).toBe(true);
	});

	it('excludes verified_in_slack rows from total_pending', async () => {
		mockExecute.mockResolvedValue({
			rows: [row({ id: 1 }), row({ id: 2, status: 'verified_in_slack' })],
		});
		const json = await (await GET(authed as never)).json();
		expect(json.total_requested).toBe(2);
		expect(json.total_pending).toBe(1);
	});

	it('returns status as a string', async () => {
		mockExecute.mockResolvedValue({ rows: [row({ status: 'contacted' })] });
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].status).toBe('contacted');
	});

	it('returns lastEditedByName from the database', async () => {
		mockExecute.mockResolvedValue({
			rows: [row({ last_edited_by_name: 'Alice', last_edited_by_id: 'U123' })],
		});
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].lastEditedByName).toBe('Alice');
		expect(json.pending[0].lastEditedById).toBe('U123');
	});

	it('returns null lastEditedByName when row has never been edited', async () => {
		mockExecute.mockResolvedValue({ rows: [row()] });
		const json = await (await GET(authed as never)).json();
		expect(json.pending[0].lastEditedByName).toBeNull();
	});

	it('paginates through Slack member pages using cursor', async () => {
		mockExecute.mockResolvedValue({ rows: [row()] });
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
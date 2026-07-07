import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from './+server.js';

const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockComputePlan = vi.hoisted(() => vi.fn());
const mockInvite = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({
	slack: { conversations: { invite: mockInvite } },
}));
vi.mock('$lib/server/env', () => ({ SOLIDARITY_API_TOKEN: 'tok' }));
vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));
vi.mock('$lib/server/chapter-reconcile', () => ({
	computeChapterMovePlan: mockComputePlan,
}));

const authed = {
	locals: { session: { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true } },
};
const unauthed = { locals: { session: null } };
const nonAdmin = {
	locals: { session: { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false } },
};

const MAPPINGS = [
	{ chapterId: 1, channelId: 'C_A', name: 'Lapeer' },
	{ chapterId: 2, channelId: 'C_B', name: 'Macomb' },
];

function getEvent(session: typeof authed | typeof unauthed | typeof nonAdmin) {
	return { ...session };
}

function postEvent(session: typeof authed | typeof unauthed | typeof nonAdmin, body: unknown) {
	return {
		...session,
		request: { json: async () => body } as Request,
	};
}

describe('GET /api/settings/chapter-channels/reconcile', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSettings.mockResolvedValue({ chapterChannelMap: MAPPINGS });
		mockComputePlan.mockResolvedValue({
			channels: [],
			alreadyInPlaceCount: 3,
			notInSlackCount: 1,
			unmappedChaptersCount: 0,
		});
	});

	it('401 / 403 gates', async () => {
		expect((await GET(getEvent(unauthed) as never)).status).toBe(401);
		expect((await GET(getEvent(nonAdmin) as never)).status).toBe(403);
		expect(mockComputePlan).not.toHaveBeenCalled();
	});

	it('409 when no mappings are configured', async () => {
		mockLoadSettings.mockResolvedValue({ chapterChannelMap: [] });
		const res = await GET(getEvent(authed) as never);
		expect(res.status).toBe(409);
		expect(mockComputePlan).not.toHaveBeenCalled();
	});

	it('returns the computed plan for the mapped entries', async () => {
		const res = await GET(getEvent(authed) as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ alreadyInPlaceCount: 3 });
		expect(mockComputePlan).toHaveBeenCalledWith(
			expect.objectContaining({ token: 'tok', entries: MAPPINGS }),
		);
	});

	it('502 when the plan computation fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockComputePlan.mockRejectedValue(new Error('solidarity down'));
		const res = await GET(getEvent(authed) as never);
		expect(res.status).toBe(502);
	});
});

describe('POST /api/settings/chapter-channels/reconcile', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		mockLoadSettings.mockResolvedValue({ chapterChannelMap: MAPPINGS });
		mockInvite.mockResolvedValue({ ok: true });
	});

	it('400 for an empty or malformed targets array', async () => {
		for (const targets of [undefined, [], [{ channelId: 'C_A' }], 'nope']) {
			const res = await POST(postEvent(authed, { targets }) as never);
			expect(res.status).toBe(400);
		}
		expect(mockInvite).not.toHaveBeenCalled();
	});

	it('batches invites per channel in one API call, deduping users', async () => {
		const res = await POST(
			postEvent(authed, {
				targets: [
					{ channelId: 'C_A', slackUserId: 'U1', email: 'a@x.org' },
					{ channelId: 'C_A', slackUserId: 'U2', email: 'b@x.org' },
					{ channelId: 'C_A', slackUserId: 'U1', email: 'a@x.org' },
					{ channelId: 'C_B', slackUserId: 'U1', email: 'a@x.org' },
				],
			}) as never,
		);
		expect(res.status).toBe(200);
		expect(mockInvite).toHaveBeenCalledTimes(2);
		expect(mockInvite).toHaveBeenCalledWith({ channel: 'C_A', users: 'U1,U2' });
		expect(mockInvite).toHaveBeenCalledWith({ channel: 'C_B', users: 'U1' });
		const { results } = (await res.json()) as { results: { ok: boolean }[] };
		expect(results).toHaveLength(3);
		expect(results.every((r) => r.ok)).toBe(true);
	});

	it('rejects channels outside the chapter map without touching Slack for them', async () => {
		const res = await POST(
			postEvent(authed, {
				targets: [{ channelId: 'C_EVIL', slackUserId: 'U1', email: 'a@x.org' }],
			}) as never,
		);
		expect(res.status).toBe(200);
		expect(mockInvite).not.toHaveBeenCalled();
		const { results } = (await res.json()) as {
			results: { ok: boolean; error?: string }[];
		};
		expect(results[0]!.ok).toBe(false);
		expect(results[0]!.error).toMatch(/not in the chapter/);
	});

	it('maps Slack per-user partial failures, treating already_in_channel as success', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockInvite.mockRejectedValue(
			Object.assign(new Error('An API error occurred: errors'), {
				data: {
					errors: [
						{ user: 'U1', error: 'already_in_channel' },
						{ user: 'U2', error: 'cant_invite' },
					],
				},
			}),
		);
		const res = await POST(
			postEvent(authed, {
				targets: [
					{ channelId: 'C_A', slackUserId: 'U1', email: 'a@x.org' },
					{ channelId: 'C_A', slackUserId: 'U2', email: 'b@x.org' },
					{ channelId: 'C_A', slackUserId: 'U3', email: 'c@x.org' },
				],
			}) as never,
		);
		const { results } = (await res.json()) as {
			results: { slackUserId: string; ok: boolean; error?: string }[];
		};
		const byUser = new Map(results.map((r) => [r.slackUserId, r]));
		expect(byUser.get('U1')!.ok).toBe(true); // already there → success
		expect(byUser.get('U2')!.ok).toBe(false);
		expect(byUser.get('U2')!.error).toBe('cant_invite');
		expect(byUser.get('U3')!.ok).toBe(true); // not in errors array → invited
	});

	it('marks the whole chunk failed on a wholesale error (e.g. bot not in channel)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockInvite.mockRejectedValue(new Error('An API error occurred: not_in_channel'));
		const res = await POST(
			postEvent(authed, {
				targets: [
					{ channelId: 'C_A', slackUserId: 'U1', email: 'a@x.org' },
					{ channelId: 'C_A', slackUserId: 'U2', email: 'b@x.org' },
				],
			}) as never,
		);
		const { results } = (await res.json()) as { results: { ok: boolean; error?: string }[] };
		expect(results.every((r) => !r.ok)).toBe(true);
		expect(results[0]!.error).toMatch(/not_in_channel/);
	});
});

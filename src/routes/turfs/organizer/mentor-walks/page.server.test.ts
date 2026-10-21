import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions, load } from './+page.server.js';

const store = vi.hoisted(() => ({
	appointMentor: vi.fn(),
	campaignMetrics: vi.fn(async () => ({
		walksHosted: 0,
		seatsOffered: 0,
		seatsTaken: 0,
		attendanceRate: null,
		noShowReports: 0,
		followedOnRate: null,
	})),
	listMentors: vi.fn(),
	listWalksForOrganizer: vi.fn(),
	loadMentor: vi.fn(),
	loadWalkByPublicId: vi.fn(async (_db: unknown, publicId: string) =>
		publicId === 'k3Xq9vR2mT8w' ? { id: 7, publicId } : null,
	),
	mentorTotals: vi.fn(),
	reinstateMentor: vi.fn(),
	revokeMentor: vi.fn(),
	setWalkStatus: vi.fn(),
}));
const mockSettings = vi.hoisted(() => vi.fn());
const mockBlocked = vi.hoisted(() => vi.fn());
const mockSlackUsers = vi.hoisted(() => vi.fn());
const mockOutside = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/slack.js', () => ({ slack: {} }));
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: mockSettings,
	loadVanBlockedIds: mockBlocked,
}));
vi.mock('$lib/server/autocomplete-sources.js', () => ({ getSlackUsers: mockSlackUsers }));
vi.mock('$lib/server/outside-volunteers.js', () => ({
	loadBlockableOutsideVolunteers: mockOutside,
}));
vi.mock('$lib/server/mentor-walks/store.js', () => store);
vi.mock('$lib/server/mentor-walks/seats.js', () => ({ heldSeats: async () => new Map() }));
const mockDispatch = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/mentor-walks/dispatch.js', () => ({ dispatchSoon: mockDispatch }));

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Alex', isAdmin: true };
const VOLUNTEER = { slackUserId: 'U_VOL', slackUserName: 'Vol', isAdmin: false };

const form = (fields: Record<string, string>) => {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return new Request('https://app.example/turfs/organizer/mentor-walks', { method: 'POST', body });
};

const run = (name: keyof typeof actions, session: unknown, fields: Record<string, string> = {}) =>
	(actions[name] as (e: unknown) => Promise<unknown>)({
		locals: { session },
		request: form(fields),
	});

beforeEach(() => {
	vi.clearAllMocks();
	mockSettings.mockResolvedValue({
		chapterChannelMap: [{ chapterId: 71, channelId: 'C1', name: 'Washtenaw County' }],
		turfCustomChapters: [],
		mentorWalksVisibility: 'staff',
		volunteerGuidelinesUrl: 'https://example.org/g',
	});
	mockBlocked.mockResolvedValue(new Set(['U_BLOCKED']));
	mockSlackUsers.mockResolvedValue({
		items: [
			{ id: 'U_KIM', name: 'Kimberly' },
			{ id: 'U_BLOCKED', name: 'Blocked' },
			{ id: 'U_MENTOR', name: 'Mentor' },
		],
	});
	mockOutside.mockResolvedValue([{ userId: 'google:1', displayName: 'Gale' }]);
	store.listWalksForOrganizer.mockResolvedValue({ upcoming: [], past: [] });
	store.listMentors.mockResolvedValue([
		{
			holderId: 'U_MENTOR',
			holderName: 'Mentor',
			status: 'active',
			agreedAt: '2026-10-02T12:00:00.000Z',
			agreedUrl: 'https://example.org/g',
			appointedBy: null,
			appointedByName: null,
			revokedAt: null,
			revokedByName: null,
		},
	]);
	store.mentorTotals.mockResolvedValue(new Map());
	store.revokeMentor.mockResolvedValue([]);
});

describe('load', () => {
	it('turns away anyone but an admin', async () => {
		await expect(load({ locals: { session: VOLUNTEER } } as never)).rejects.toMatchObject({
			status: 302,
		});
	});

	it('offers everyone not blocked and not already a mentor', async () => {
		const data = (await load({ locals: { session: ADMIN } } as never)) as {
			candidates: { id: string }[];
			visibilityLabel: string;
			mentors: { id: string; agreedLabel: string | null }[];
		};
		expect(data.candidates.map((c) => c.id)).toEqual(['google:1', 'U_KIM']);
		expect(data.visibilityLabel).toBe('Admins and moderators only');
		expect(data.mentors).toMatchObject([{ id: 'U_MENTOR', agreedLabel: 'Oct 2' }]);
	});
});

describe('actions', () => {
	it('refuses every action to a non-admin', async () => {
		for (const name of Object.keys(actions) as (keyof typeof actions)[]) {
			expect(await run(name, VOLUNTEER, { walkId: '1', holderId: 'U_KIM' })).toMatchObject({
				status: 403,
			});
		}
		expect(store.setWalkStatus).not.toHaveBeenCalled();
		expect(store.appointMentor).not.toHaveBeenCalled();
		expect(store.revokeMentor).not.toHaveBeenCalled();
	});

	it('makes a mentor, but not someone blocked', async () => {
		store.loadMentor.mockResolvedValue(null);
		store.appointMentor.mockResolvedValue(true);
		expect(await run('makeMentor', ADMIN, { holderId: 'U_KIM' })).toEqual({
			mentorMade: 'Kimberly',
		});
		expect(store.appointMentor).toHaveBeenCalledWith(
			{},
			{ id: 'U_KIM', name: 'Kimberly' },
			{ id: 'U_ADMIN', name: 'Alex' },
			expect.any(Date),
		);
		expect(await run('makeMentor', ADMIN, { holderId: 'U_BLOCKED' })).toMatchObject({
			status: 409,
		});
	});

	it('revokes only an active mentor', async () => {
		store.loadMentor.mockResolvedValue({ status: 'active', holderName: 'Mentor' });
		expect(await run('revokeMentor', ADMIN, { holderId: 'U_MENTOR' })).toEqual({
			mentorRevoked: 'Mentor',
			walksCancelled: 0,
		});
		store.loadMentor.mockResolvedValue({ status: 'revoked', holderName: 'Mentor' });
		expect(await run('revokeMentor', ADMIN, { holderId: 'U_MENTOR' })).toMatchObject({
			status: 409,
		});
	});

	it('hides a walk', async () => {
		store.setWalkStatus.mockResolvedValue(true);
		expect(await run('hideWalk', ADMIN, { walkId: 'k3Xq9vR2mT8w' })).toEqual({
			walkHidden: 'k3Xq9vR2mT8w',
		});
		expect(store.setWalkStatus).toHaveBeenCalledWith(
			{},
			7,
			'hidden',
			{ id: 'U_ADMIN', name: 'Alex' },
			expect.any(Date),
		);
		// The database id is never taken from the page.
		expect(await run('hideWalk', ADMIN, { walkId: '7' })).toMatchObject({ status: 409 });
	});
});

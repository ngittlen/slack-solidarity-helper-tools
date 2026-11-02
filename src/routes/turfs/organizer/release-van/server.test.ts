import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from './+server.js';

const mockReleaseAll = vi.hoisted(() => vi.fn());
const mockHeld = vi.hoisted(() => vi.fn());
const mockFolders = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: async () => ({ vanAssignmentTtlHours: 72 }),
}));
vi.mock('$lib/server/van/campaigns.js', () => ({
	loadCampaign: async (_db: unknown, id: number) => ({ id, credentialKey: 'primary', label: null }),
	campaignName: () => 'primary',
}));
vi.mock('$lib/server/van/folder-names.js', () => ({ vanFolderNames: mockFolders }));
vi.mock('$lib/server/van/turf-van-release-store.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/van/turf-van-release-store.js')>()),
	releaseAllVanAssignments: mockReleaseAll,
	vanOnlyHeldTurfs: mockHeld,
}));

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Alex', isAdmin: true };
const SEEN = [
	{ turfId: 100, since: '2026-10-01T12:00:00.000Z' },
	{ turfId: 101, since: null },
];
const COUNTED_AT = '2026-10-10T17:30:00.000Z';
const post = (session: unknown, body: unknown = { countedAt: COUNTED_AT, turfs: SEEN }) =>
	POST({
		locals: { session },
		request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
	} as never);
const get = (session: unknown) => GET({ locals: { session } } as never);

describe('/turfs/organizer/release-van', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReleaseAll.mockResolvedValue({ released: 1, skipped: { claimed: 1 } });
		mockHeld.mockResolvedValue([
			{ turfId: 100, campaignId: 1, folderId: 10, chapterName: 'Washtenaw', since: SEEN[0]!.since },
			{ turfId: 101, campaignId: 1, folderId: 10, chapterName: 'Washtenaw', since: null },
		]);
		mockFolders.mockResolvedValue(new Map([[10, 'R06F_Washtenaw']]));
	});

	it('refuses the signed-out, and anyone but an admin', async () => {
		const moderator = { ...ADMIN, isAdmin: false, isModerator: true };
		expect((await post(null)).status).toBe(401);
		expect((await post(moderator)).status).toBe(403);
		expect((await get(null)).status).toBe(401);
		expect((await get(moderator)).status).toBe(403);
		expect(mockReleaseAll).not.toHaveBeenCalled();
		expect(mockHeld).not.toHaveBeenCalled();
	});

	it('counts what the release frees by VAN folder, with each hand-out time', async () => {
		const res = await get(ADMIN);
		expect(await res.json()).toEqual({
			countedAt: expect.any(String),
			turfs: SEEN,
			folders: [
				{
					campaignId: 1,
					campaign: null,
					folderId: 10,
					name: 'R06F_Washtenaw',
					chapterName: 'Washtenaw',
					count: 2,
				},
			],
		});
		expect(mockHeld.mock.calls[0]![2]).toBe(72);
	});

	it('still counts by folder id when VAN cannot name the folders', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFolders.mockRejectedValue(new Error('VAN is down'));
		const { folders } = await (await get(ADMIN)).json();
		expect(folders[0]).toMatchObject({ folderId: 10, name: null, count: 2 });
	});

	it('releases what the summary counted, under the admin’s name and the time limit', async () => {
		const res = await post(ADMIN);
		expect(await res.json()).toEqual({ released: 1, skipped: { claimed: 1 } });
		const [, seen, countedAt, editor, , ttl] = mockReleaseAll.mock.calls[0]!;
		expect(seen).toEqual(SEEN);
		expect(countedAt).toEqual(new Date(COUNTED_AT));
		expect(editor).toEqual({ id: 'U_ADMIN', name: 'Alex' });
		expect(ttl).toBe(72);
	});

	it('refuses a release that does not say what it saw', async () => {
		const counted = (turfs: unknown) => ({ countedAt: COUNTED_AT, turfs });
		expect((await post(ADMIN, {})).status).toBe(400);
		expect((await post(ADMIN, { turfs: SEEN })).status).toBe(400);
		expect((await post(ADMIN, { countedAt: 'soon', turfs: SEEN })).status).toBe(400);
		expect((await post(ADMIN, counted([{ turfId: 'x', since: null }]))).status).toBe(400);
		expect((await post(ADMIN, counted([{ turfId: 1, since: 5 }]))).status).toBe(400);
		expect(mockReleaseAll).not.toHaveBeenCalled();
	});
});

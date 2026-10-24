import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualSyncRun } from '$lib/server/van/manual-sync-report.js';

const mockLatest = vi.hoisted(() => vi.fn());
const mockRequested = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/van/manual-sync.js', () => ({ latestManualVanSync: mockLatest }));
// The labels are pure: the real ones, so the test reads what the page shows.
vi.mock('$lib/server/van/turf-placement.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/van/turf-placement.js')>();
	return {
		requestedTurfLabel: actual.requestedTurfLabel,
		requestedTurfCaveats: actual.requestedTurfCaveats,
		loadRequestedTurf: mockRequested,
	};
});

const { manualSyncView } = await import('./manual-sync-view.js');

const NOW = new Date('2026-10-23T18:00:00.000Z');
const MINUTE = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function run(over: Partial<ManualSyncRun> = {}): ManualSyncRun {
	return {
		id: 1,
		startedAt: ago(10 * MINUTE),
		startedByName: 'Alex',
		phase: 'done',
		passes: 1,
		finishedAt: ago(2 * MINUTE),
		stalled: false,
		requestedTurfIds: [400, 401],
		report: {
			campaigns: [{ campaignId: 1, name: 'Main', outcome: 'synced', noRequestedFolder: false }],
		},
		...over,
	};
}

const turf = {
	turfId: 500,
	campaignId: 1,
	name: 'Request 1',
	regionName: 'Requests',
	firstSeenAt: ago(5 * MINUTE),
	located: false,
	shape: 'waiting',
	shapeError: null,
	claimable: true,
	hidden: false,
	missed: false,
	placement: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockRequested.mockResolvedValue({ turfs: [], total: 0 });
});

describe('manualSyncView', () => {
	it('shows nothing before the first press, or long after the last', async () => {
		mockLatest.mockResolvedValueOnce(null);
		expect(await manualSyncView(NOW)).toBeNull();
		mockLatest.mockResolvedValueOnce(run({ finishedAt: ago(3 * 60 * MINUTE) }));
		expect(await manualSyncView(NOW)).toBeNull();
	});

	it('says where a running press has got to, and who pressed', async () => {
		mockLatest.mockResolvedValueOnce(run({ phase: 'shapes', finishedAt: null }));
		const view = (await manualSyncView(NOW))!;
		expect(view.running).toBe(true);
		expect(view.status).toBe('Loading map shapes, new turf first. Started 10m ago by Alex.');
	});

	// Asks only for turf first read since the press started.
	it('lists the turf it picked up, with what each still waits on', async () => {
		mockLatest.mockResolvedValueOnce(run());
		mockRequested.mockResolvedValueOnce({
			total: 2,
			turfs: [
				turf,
				{
					...turf,
					turfId: 501,
					located: true,
					shape: null,
					claimable: false,
					placement: { chapterId: 71, chapterName: 'Washtenaw', source: 'zip', zip: '48104' },
				},
			],
		});
		const view = (await manualSyncView(NOW))!;
		expect(mockRequested).toHaveBeenCalledWith({}, 20, { excludeTurfIds: [400, 401] });
		expect(view.newTurf).toEqual([
			expect.objectContaining({
				turfId: 500,
				label: 'Not placed yet: waiting for its shape from VAN',
				ready: false,
			}),
			expect.objectContaining({
				turfId: 501,
				label: 'By ZIP 48104',
				caveats: [expect.stringContaining('No MiniVAN list number yet')],
				ready: false,
			}),
		]);
	});

	// A record from before the list was kept.
	it('falls back to when turf was first read without the list', async () => {
		mockLatest.mockResolvedValueOnce(run({ requestedTurfIds: null }));
		await manualSyncView(NOW);
		expect(mockRequested).toHaveBeenCalledWith({}, 20, { firstSeenSince: ago(10 * MINUTE) });
	});

	// The failure is the reason then, not the folder.
	it('does not blame the folder when a campaign was not read', async () => {
		mockLatest.mockResolvedValueOnce(
			run({
				report: {
					campaigns: [
						{ campaignId: 1, name: 'Main', outcome: 'skipped', noRequestedFolder: false },
					],
				},
			}),
		);
		const { notes } = (await manualSyncView(NOW))!;
		expect(notes.map((n) => n.text)).toEqual([expect.stringContaining('Main: not read')]);
	});

	it('says a campaign the press stopped waiting on is still running, not failed', async () => {
		mockLatest.mockResolvedValueOnce(
			run({
				report: {
					campaigns: [{ campaignId: 1, name: 'Main', outcome: 'slow', noRequestedFolder: false }],
				},
			}),
		);
		const { notes } = (await manualSyncView(NOW))!;
		expect(notes).toEqual([
			{
				text:
					'Main: VAN is taking a while — the sync is still running on the server. ' +
					'Check back in a few minutes: new turf it reads shows up under Requested turf.',
				error: false,
			},
		]);
	});

	it('says when loading a campaign’s map shapes failed', async () => {
		mockLatest.mockResolvedValueOnce(
			run({
				report: {
					campaigns: [{ campaignId: 1, name: 'Main', outcome: 'synced', noRequestedFolder: false }],
					drain: [{ campaignId: 1, attempted: 0, mapped: 0, failed: 'database is gone' }],
				},
			}),
		);
		mockRequested.mockResolvedValueOnce({ turfs: [turf], total: 1 });
		const { notes } = (await manualSyncView(NOW))!;
		expect(notes).toEqual([
			{
				text: 'Main: loading map shapes failed — database is gone. The rest load with the scheduled syncs.',
				error: true,
			},
		]);
	});

	it('says so when a finished press found nothing new', async () => {
		mockLatest.mockResolvedValueOnce(run());
		const view = (await manualSyncView(NOW))!;
		expect(view.notes).toEqual([
			expect.objectContaining({ text: expect.stringContaining('No new turf turned up') }),
		]);
	});

	it('names what kept turf back, linking to the fix', async () => {
		mockLatest.mockResolvedValueOnce(
			run({
				report: {
					campaigns: [
						{
							campaignId: 1,
							name: 'Main',
							outcome: 'failed',
							error: 'VAN rejected the API key',
							noRequestedFolder: true,
						},
						{
							campaignId: 2,
							name: 'Partner',
							outcome: 'synced',
							newRoutesHeld: 3,
							noRequestedFolder: true,
						},
					],
					drain: [
						{ campaignId: 1, attempted: 0, mapped: 0, stopped: 'not configured' },
						{ campaignId: 2, attempted: 12, mapped: 10, stopped: 'out of time' },
					],
				},
			}),
		);
		mockRequested.mockResolvedValueOnce({ turfs: [turf], total: 1 });
		const { notes } = (await manualSyncView(NOW))!;
		expect(notes).toEqual([
			{
				text: 'Main: the VAN sync failed — VAN rejected the API key. No new turf was read.',
				error: true,
				campaignId: 1,
			},
			{
				text: expect.stringContaining('Partner: 3 new routes not added yet'),
				error: false,
			},
			{
				text: expect.stringContaining('No campaign has a requested-turf folder set'),
				error: true,
				campaignId: 1,
			},
			{
				text: expect.stringContaining('Main: map shapes cannot load'),
				error: true,
				campaignId: 1,
			},
			{
				text: 'Map shapes: 10 of 12 turf put on the map. The rest load with the scheduled syncs.',
				error: false,
			},
		]);
	});

	it('tells the organizer to press again when the press died', async () => {
		mockLatest.mockResolvedValueOnce(run({ phase: 'reading', finishedAt: null, stalled: true }));
		const view = (await manualSyncView(NOW))!;
		expect(view.running).toBe(false);
		expect(view.stalled).toBe(true);
		expect(view.status).toContain('stopped partway');
		expect(view.notes).toEqual([]);
	});
});

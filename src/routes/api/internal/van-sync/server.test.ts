import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockRunCatalogSync = vi.hoisted(() => vi.fn());
const mockVanClient = vi.hoisted(() => vi.fn());
const mockAcquire = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());
const mockSweep = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({ INTERNAL_CRON_SECRET: 'cron-secret' }));

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/slack.js', () => ({
	slack: { chat: { postMessage: mockPostMessage } },
}));
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: async () => ({ slackTrackingChannelId: 'C_TRACK' }),
	loadVanChapterFolders: async () => [
		{ chapterId: 71, chapterName: 'Washtenaw County', folderIds: [2731] },
	],
}));
vi.mock('$lib/server/sync-lock.js', () => ({
	acquireSyncLock: mockAcquire,
	releaseSyncLock: mockRelease,
}));
vi.mock('$lib/server/van-env.js', () => ({ vanClient: mockVanClient }));
vi.mock('$lib/server/van/sync.js', () => ({ runCatalogSync: mockRunCatalogSync }));
vi.mock('$lib/server/van/checkout-store.js', () => ({ sweepExpiredClaims: mockSweep }));
vi.mock('$lib/server/env.js', () => ({
	get INTERNAL_CRON_SECRET() {
		return mockEnv.INTERNAL_CRON_SECRET;
	},
}));

const result = {
	foldersSynced: 1,
	foldersSkipped: 0,
	turfsUpserted: 3,
	turfsRetired: 0,
	turfsUnretired: 0,
	geometryQueued: 3,
	claimsReleased: 0,
	degraded: [],
	warnings: [],
};

const event = (key = 'cron-secret') =>
	({ url: new URL(`https://app.example/api/internal/van-sync?key=${key}`) }) as never;

describe('POST /api/internal/van-sync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockEnv.INTERNAL_CRON_SECRET = 'cron-secret';
		mockVanClient.mockReturnValue({ ok: true, client: {} });
		mockAcquire.mockResolvedValue('lock-token');
		mockRunCatalogSync.mockResolvedValue(result);
		mockSweep.mockResolvedValue(0);
	});

	it('returns 401 for a wrong key', async () => {
		const res = await POST(event('nope'));
		expect(res.status).toBe(401);
		expect(mockRunCatalogSync).not.toHaveBeenCalled();
	});

	it('returns 500 when INTERNAL_CRON_SECRET is unset rather than running unauthenticated', async () => {
		mockEnv.INTERNAL_CRON_SECRET = '';
		const res = await POST(event(''));
		expect(res.status).toBe(500);
		expect(mockRunCatalogSync).not.toHaveBeenCalled();
	});

	it('returns 500 with the reason when VAN is not configured', async () => {
		mockVanClient.mockReturnValue({ ok: false, error: 'VAN_API_KEY is not set' });
		const res = await POST(event());
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'VAN_API_KEY is not set' });
	});

	it('runs the sync with the configured chapter mapping', async () => {
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ...result, claimsExpired: 0 });
		expect(mockRunCatalogSync).toHaveBeenCalledWith({}, {}, [
			{ chapterId: 71, chapterName: 'Washtenaw County', folderIds: [2731] },
		]);
		expect(mockRelease).toHaveBeenCalledWith({}, 'van-catalog-sync', 'lock-token');
	});

	it('skips without error when another sync holds the lock', async () => {
		mockAcquire.mockResolvedValue(null);
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect((await res.json()).skipped).toBeTruthy();
		expect(mockRunCatalogSync).not.toHaveBeenCalled();
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('posts degraded-tier and warning notices to Slack', async () => {
		mockRunCatalogSync.mockResolvedValue({
			...result,
			degraded: ['/minivanExports unavailable'],
			warnings: ['2 turf(s) have no MiniVAN list number'],
		});
		await POST(event());
		const text = mockPostMessage.mock.calls[0]![0].text as string;
		expect(text).toContain('/minivanExports unavailable');
		expect(text).toContain('no MiniVAN list number');
	});

	it('still succeeds when Slack is down', async () => {
		mockRunCatalogSync.mockResolvedValue({ ...result, warnings: ['something'] });
		mockPostMessage.mockRejectedValue(new Error('slack is down'));
		const res = await POST(event());
		expect(res.status).toBe(200);
	});

	// Ledger housekeeping rides this schedule rather than needing its own cron.
	it('sweeps expired claims and reports the count', async () => {
		mockSweep.mockResolvedValue(3);
		const res = await POST(event());
		expect(mockSweep).toHaveBeenCalled();
		expect((await res.json()).claimsExpired).toBe(3);
	});

	it('sweeps before the catalog fetch, so a VAN outage does not skip it', async () => {
		mockRunCatalogSync.mockRejectedValue(new Error('VAN is down'));
		const res = await POST(event());
		expect(res.status).toBe(500);
		expect(mockSweep).toHaveBeenCalled();
	});

	it('releases the lock when the sync throws', async () => {
		mockRunCatalogSync.mockRejectedValue(new Error('VAN /folders returned 500'));
		const res = await POST(event());
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'VAN /folders returned 500' });
		expect(mockRelease).toHaveBeenCalledWith({}, 'van-catalog-sync', 'lock-token');
	});
});

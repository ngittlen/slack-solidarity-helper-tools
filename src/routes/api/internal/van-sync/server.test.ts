import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockRunCatalogSync = vi.hoisted(() => vi.fn());
const mockVanClient = vi.hoisted(() => vi.fn());
const mockAcquire = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());
const mockSweep = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
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
vi.mock('$lib/server/van/expiry-warning-store.js', () => ({ sendExpiryWarnings: mockWarn }));
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
		mockWarn.mockResolvedValue({ sent: 0, failed: 0 });
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
		mockSweep.mockResolvedValue(2);
		mockWarn.mockResolvedValue({ sent: 3, failed: 1 });
		const res = await POST(event());
		expect(res.status).toBe(500);
		// Same housekeeping fields as the success path, so a monitor parsing this
		// does not have to cope with keys that appear and disappear.
		expect(await res.json()).toEqual({
			error: 'VAN_API_KEY is not set',
			claimsExpired: 2,
			expiryWarningsSent: 3,
			expiryWarningsFailed: 1,
		});
	});

	// Ledger housekeeping does not need VAN, and a key rotated badly on a Friday
	// must not stop volunteers being warned about turf they are already holding.
	it('still sweeps and warns when VAN is not configured', async () => {
		mockVanClient.mockReturnValue({ ok: false, error: 'VAN_API_KEY is not set' });
		await POST(event());
		expect(mockSweep).toHaveBeenCalled();
		expect(mockWarn).toHaveBeenCalled();
		expect(mockRunCatalogSync).not.toHaveBeenCalled();
	});

	it('releases the lock even when VAN is not configured', async () => {
		mockVanClient.mockReturnValue({ ok: false, error: 'VAN_API_KEY is not set' });
		await POST(event());
		expect(mockRelease).toHaveBeenCalledWith({}, 'van-catalog-sync', 'lock-token');
	});

	// Sweep first, then warn: nobody should be told that turf which lapsed
	// moments ago is about to lapse.
	it('sweeps before it warns, against the same clock', async () => {
		const order: string[] = [];
		mockSweep.mockImplementation(async () => {
			order.push('sweep');
			return 0;
		});
		mockWarn.mockImplementation(async () => {
			order.push('warn');
			return { sent: 0, failed: 0 };
		});
		await POST(event());
		expect(order).toEqual(['sweep', 'warn']);
		expect(mockWarn.mock.calls[0]![1]).toBe(mockSweep.mock.calls[0]![1]);
	});

	it('reports what the warning sweep did', async () => {
		mockWarn.mockResolvedValue({ sent: 4, failed: 1 });
		const body = await (await POST(event())).json();
		expect(body).toMatchObject({ expiryWarningsSent: 4, expiryWarningsFailed: 1 });
	});

	it('runs the sync with the configured chapter mapping', async () => {
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			...result,
			claimsExpired: 0,
			expiryWarningsSent: 0,
			expiryWarningsFailed: 0,
		});
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

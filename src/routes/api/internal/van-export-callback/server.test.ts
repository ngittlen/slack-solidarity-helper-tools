import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';
import { vanSyncLock } from '$lib/server/van/locks.js';
import { signWebhookToken } from '$lib/server/van/webhook-token.js';

const mockRunGeometryQueue = vi.hoisted(() => vi.fn());
const mockVanClient = vi.hoisted(() => vi.fn());
const mockExportJobTypeId = vi.hoisted(() => vi.fn());
/** The turf's campaign as the route looks it up; empty for an unknown turf. */
const mockTurfCampaign = vi.hoisted(() => vi.fn());
const mockAlertFor = vi.hoisted(() => vi.fn(() => async () => undefined));
const mockAcquire = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({ INTERNAL_CRON_SECRET: 'cron-secret' }));
const mockSeveral = vi.hoisted(() => vi.fn(async () => false));

vi.mock('$lib/server/db.js', () => ({
	db: {
		select: () => ({
			from: () => ({ innerJoin: () => ({ where: async () => mockTurfCampaign() }) }),
		}),
	},
}));
vi.mock('$lib/server/slack.js', () => ({ alertFor: mockAlertFor }));
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: async () => ({ slackTrackingChannelId: 'C_TRACK' }),
}));
vi.mock('$lib/server/sync-lock.js', () => ({
	acquireSyncLock: mockAcquire,
	releaseSyncLock: mockRelease,
}));
vi.mock('$lib/server/van-env.js', () => ({
	vanClientFor: mockVanClient,
	vanExportJobTypeIdFor: mockExportJobTypeId,
	vanPersonHasher: () => null,
}));
vi.mock('$lib/server/van/campaigns.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/van/campaigns.js')>()),
	severalCampaignsEnabled: mockSeveral,
}));
vi.mock('$lib/server/van/geometry-worker.js', () => ({
	runGeometryQueue: mockRunGeometryQueue,
}));
vi.mock('$lib/server/env.js', () => ({
	get INTERNAL_CRON_SECRET() {
		return mockEnv.INTERNAL_CRON_SECRET;
	},
	APP_URL: 'https://app.example',
}));

const geometryResult = {
	attempted: 1,
	hullsStored: 1,
	centroidsOnly: 0,
	noGeometry: 0,
	hullsTooLarge: 0,
	geocodedFromAddress: 0,
	retried: 0,
	deadLettered: 0,
	deadLetters: [],
	stillRunning: 0,
	budgetLapsed: false,
	warnings: [],
};

/** The URL VAN would post to for `turfId`, as this route issues it. */
function event(query = `turf=100&token=${signWebhookToken('cron-secret', 100)}`) {
	return {
		url: new URL(`https://app.example/api/internal/van-export-callback?${query}`),
		request: new Request('https://app.example/x', {
			method: 'POST',
			body: JSON.stringify({ exportJobId: 900 }),
			headers: { 'Content-Type': 'application/json' },
		}),
	} as never;
}

/** Turf 100 belongs to campaign 2: the job was submitted with its key. */
const CAMPAIGN = {
	id: 2,
	credentialKey: 'other',
	label: 'El-Sayed',
	enabled: true,
	exportJobTypeId: 5,
};

describe('POST /api/internal/van-export-callback', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockEnv.INTERNAL_CRON_SECRET = 'cron-secret';
		mockVanClient.mockReturnValue({ ok: true, client: {} });
		mockExportJobTypeId.mockReturnValue(5);
		mockAcquire.mockResolvedValue('lock-token');
		mockRunGeometryQueue.mockResolvedValue(geometryResult);
		mockTurfCampaign.mockResolvedValue([{ campaign: CAMPAIGN }]);
	});

	it('drains the queue for a correctly signed turf', async () => {
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect(mockRunGeometryQueue).toHaveBeenCalledOnce();
	});

	// The whole reason this route does not use `?key=`: VAN holds the URL, so
	// the credential in it must not be the one gating every other internal
	// endpoint.
	it('rejects the shared cron secret, which VAN must never have been given', async () => {
		const res = await POST(event('key=cron-secret'));
		expect(res.status).toBe(401);
		expect(mockRunGeometryQueue).not.toHaveBeenCalled();
	});

	it('rejects a missing, malformed or wrong-turf token', async () => {
		const valid = signWebhookToken('cron-secret', 100);
		for (const query of [
			'',
			'turf=100',
			'turf=100&token=nonsense',
			`turf=101&token=${valid}`,
			`turf=abc&token=${valid}`,
		]) {
			const res = await POST(event(query));
			expect(res.status, query).toBe(401);
		}
		expect(mockRunGeometryQueue).not.toHaveBeenCalled();
	});

	it('returns 500 rather than draining unauthenticated when the secret is unset', async () => {
		mockEnv.INTERNAL_CRON_SECRET = '';
		const res = await POST(event());
		expect(res.status).toBe(500);
		expect(mockRunGeometryQueue).not.toHaveBeenCalled();
	});

	// Both this route and the catalog sync drain van_geometry_queue, and the
	// queue has no per-row claim. Under separate lock names they would submit
	// duplicate export jobs for the same turf.
	it("takes the same lock the turf's campaign's catalog sync takes", async () => {
		await POST(event());
		expect(mockAcquire.mock.calls[0]![1]).toBe(vanSyncLock(2));
		expect(mockRelease.mock.calls[0]![1]).toBe(vanSyncLock(2));
	});

	// Only the key that submitted an export job can read it back.
	it("drains with the turf's campaign's key, and only that campaign's queue", async () => {
		await POST(event());
		expect(mockVanClient).toHaveBeenCalledWith(CAMPAIGN);
		expect(mockExportJobTypeId).toHaveBeenCalledWith(CAMPAIGN);
		expect(mockRunGeometryQueue.mock.calls[0]![2]).toMatchObject({ campaignId: 2 });
	});

	// A disabled campaign makes no VAN calls: a job submitted just before the
	// switch still calls back, and a drain would submit new jobs for its queue.
	it('answers 200 and drains nothing for a disabled campaign', async () => {
		mockTurfCampaign.mockResolvedValue([{ campaign: { ...CAMPAIGN, enabled: false } }]);
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ skipped: 'campaign is disabled' });
		expect(mockAcquire).not.toHaveBeenCalled();
		expect(mockRunGeometryQueue).not.toHaveBeenCalled();
	});

	it('names the campaign in its alerts once several are enabled', async () => {
		await POST(event());
		expect(mockAlertFor).toHaveBeenLastCalledWith('[van]', undefined);
		mockSeveral.mockResolvedValueOnce(true);
		await POST(event());
		expect(mockAlertFor).toHaveBeenLastCalledWith('[van · El-Sayed]', undefined);
	});

	it('answers 200 and does nothing for a turf that no longer exists', async () => {
		mockTurfCampaign.mockResolvedValue([]);
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ skipped: 'unknown turf' });
		expect(mockRunGeometryQueue).not.toHaveBeenCalled();
	});

	it('skips without running when a sync already holds the lock', async () => {
		mockAcquire.mockResolvedValue(null);
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect(await res.json()).toHaveProperty('skipped');
		expect(mockRunGeometryQueue).not.toHaveBeenCalled();
	});

	// VAN retries a non-2xx, and retrying will not make the server configured.
	it('answers 200 when geometry is not configured', async () => {
		mockExportJobTypeId.mockReturnValue(null);
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect(mockRunGeometryQueue).not.toHaveBeenCalled();
	});

	it('registers per-turf callback urls on the jobs it submits', async () => {
		await POST(event());
		const { webhookUrlFor } = mockRunGeometryQueue.mock.calls[0]![2];
		const url = new URL(webhookUrlFor(585052));
		expect(url.searchParams.get('turf')).toBe('585052');
		expect(webhookUrlFor(585052)).not.toContain('cron-secret');
	});

	it('answers 200 on a worker failure so VAN does not retry into a storm', async () => {
		mockRunGeometryQueue.mockRejectedValue(new Error('db gone'));
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect(mockRelease).toHaveBeenCalledOnce();
	});
});

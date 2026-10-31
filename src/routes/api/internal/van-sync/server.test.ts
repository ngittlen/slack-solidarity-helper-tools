import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './+server.js';

const mockRunCatalogSync = vi.hoisted(() => vi.fn());
const mockRunGeometryQueue = vi.hoisted(() => vi.fn());
const mockVanClient = vi.hoisted(() => vi.fn());
const mockExportJobTypeId = vi.hoisted(() => vi.fn());
const mockAlertFor = vi.hoisted(() => vi.fn(() => async () => undefined));
const mockAcquire = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());
const mockSweep = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockPrune = vi.hoisted(() => vi.fn());
const mockDrift = vi.hoisted(() => vi.fn());
const mockListExpiry = vi.hoisted(() => vi.fn());
const mockSettle = vi.hoisted(() => vi.fn());
const mockReconcile = vi.hoisted(() => vi.fn());
const mockRefreshSweep = vi.hoisted(() => vi.fn());
const mockDoorDeltas = vi.hoisted(() => vi.fn());
const mockDoorsHealth = vi.hoisted(() => vi.fn());
const mockRunPacketTracker = vi.hoisted(() => vi.fn());
const mockSheetCheck = vi.hoisted(() => vi.fn());
const mockRunContactStage = vi.hoisted(() => vi.fn());
const mockHasher = vi.hoisted(() => vi.fn());
const mockEnsureCampaignRows = vi.hoisted(() => vi.fn());
const mockCampaigns = vi.hoisted(() => vi.fn());
const mockLoadCampaign = vi.hoisted(() => vi.fn());
const mockSeveral = vi.hoisted(() => vi.fn());
const mockRecordFailure = vi.hoisted(() => vi.fn());
const mockMarkAnnounced = vi.hoisted(() => vi.fn());
const mockPostAlert = vi.hoisted(() => vi.fn());
const mockLoadVanChapterFolders = vi.hoisted(() =>
	vi.fn(async () => [{ chapterId: 71, chapterName: 'Washtenaw County', folderIds: [2731] }]),
);
const mockEnv = vi.hoisted(() => ({ INTERNAL_CRON_SECRET: 'cron-secret' }));

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/slack.js', () => ({
	postAlert: mockPostAlert,
	slack: { chat: { postMessage: mockPostMessage } },
	alertFor: mockAlertFor,
}));
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: async () => ({
		slackTrackingChannelId: 'C_TRACK',
		slackTurfChannelId: 'C_TURF',
		vanTurfClaimTtlHours: 48,
		vanSheetTabName: 'Packet Tracker',
	}),
	loadVanChapterFolders: mockLoadVanChapterFolders,
}));
vi.mock('$lib/server/sync-lock.js', () => ({
	acquireSyncLock: mockAcquire,
	releaseSyncLock: mockRelease,
}));
vi.mock('$lib/server/van-env.js', () => ({
	ensureCampaignRows: mockEnsureCampaignRows,
	vanClientFor: mockVanClient,
	vanExportJobTypeIdFor: mockExportJobTypeId,
	vanPersonHasher: mockHasher,
}));
vi.mock('$lib/server/van/campaigns.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/van/campaigns.js')>();
	return {
		// The pure rules are the real ones: which campaign may be re-cut is
		// exactly what these tests are about.
		campaignName: real.campaignName,
		regionRefreshAllowed: real.regionRefreshAllowed,
		campaignsStalestFirst: mockCampaigns,
		loadCampaign: mockLoadCampaign,
		severalCampaignsEnabled: mockSeveral,
		recordSyncFailure: mockRecordFailure,
		markFailureAnnounced: mockMarkAnnounced,
	};
});
vi.mock('$lib/server/van/contact-live.js', () => ({ runContactStage: mockRunContactStage }));
vi.mock('$lib/server/van/geometry-worker.js', () => ({
	runGeometryQueue: mockRunGeometryQueue,
}));
vi.mock('$lib/server/van/sync.js', () => ({ runCatalogSync: mockRunCatalogSync }));
const PLACED = { byZip: 1, byNearby: 0, unplaced: 0, cleared: 0, budgetLapsed: false };
const mockPlace = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/van/turf-placement.js', () => ({ placeRequestedTurf: mockPlace }));
vi.mock('$lib/server/van/placement-chapters.js', () => ({
	placementChapters: async () => [{ chapterId: 71, name: 'Washtenaw County' }],
}));
vi.mock('$lib/server/van/checkout-store.js', () => ({ sweepExpiredClaims: mockSweep }));
vi.mock('$lib/server/van/expiry-warning-store.js', () => ({ sendExpiryWarnings: mockWarn }));
vi.mock('$lib/server/van/holder-notices.js', () => ({ pruneHolderNotices: mockPrune }));
vi.mock('$lib/server/van/drift-alert-store.js', () => ({ sendDriftAlerts: mockDrift }));
vi.mock('$lib/server/van/list-expiry-alert-store.js', () => ({
	sendListExpiryAlerts: mockListExpiry,
}));
vi.mock('$lib/server/van/refresh.js', () => ({
	settleRefreshes: mockSettle,
	runRefreshSweep: mockRefreshSweep,
}));
vi.mock('$lib/server/van/reconcile-store.js', () => ({ reconcileClaims: mockReconcile }));
vi.mock('$lib/server/van/door-delta-store.js', () => ({ stampDoorDeltas: mockDoorDeltas }));
vi.mock('$lib/server/van/claim-notices.js', () => ({
	notifyLapsedClaims: async () => ({ sent: 0, failed: 0 }),
	notifyDoorsCounted: async () => ({ sent: 0, failed: 0 }),
}));
vi.mock('$lib/server/van/doors-store.js', () => ({ doorsHealthWarning: mockDoorsHealth }));
vi.mock('$lib/server/van/packet-tracker-live.js', () => ({
	runPacketTracker: mockRunPacketTracker,
	packetTrackerCheck: () => mockSheetCheck,
}));
vi.mock('$lib/server/env.js', () => ({
	get INTERNAL_CRON_SECRET() {
		return mockEnv.INTERNAL_CRON_SECRET;
	},
	APP_URL: 'https://app.example',
}));

const result = {
	foldersSynced: 1,
	foldersSkipped: 0,
	turfsUpserted: 3,
	turfsRetired: 0,
	turfsUnretired: 0,
	geometryQueued: 3,
	claimsReleased: 0,
	regionsRead: [{ folderId: 2731, mapRegionId: 10, dateRefreshed: '2026-09-12T04:00:00.000Z' }],
	degraded: [],
	warnings: [],
};

const reconcileResult = {
	listNumbersChanged: 0,
	numbersAdopted: 0,
	walkedOut: 0,
	retiredReleased: 0,
	recutReplaced: 0,
	recutGone: 0,
	recutStale: 0,
	dmFailed: 0,
	missingListNumber: 0,
};

const doorDeltaResult = { measured: 0, unsynced: 0, doorsCleared: 0, dmFailed: 0 };

const refreshResult = {
	nightlyFolders: [],
	regionsRefreshed: 0,
	regionsDeferred: 0,
	failed: 0,
	staleCleared: 0,
	warnings: [],
};

const geometryResult = {
	attempted: 3,
	hullsStored: 3,
	centroidsOnly: 0,
	noGeometry: 0,
	geocodedFromAddress: 0,
	retried: 0,
	deadLettered: 0,
	deadLetters: [],
	stillRunning: 0,
	budgetLapsed: false,
	warnings: [],
};

const driftResult = { announced: 0, cleared: 0, failed: false, skipped: 'nothing-new' };
const event = (key = 'cron-secret', extra = '') =>
	({ url: new URL(`https://app.example/api/internal/van-sync?key=${key}${extra}`) }) as never;

/** The campaign the app has always served — the only one enabled unless a
 *  test says otherwise. */
const PRIMARY = {
	id: 1,
	credentialKey: 'primary',
	label: null,
	enabled: true,
	exportJobTypeId: null,
	// On in most tests so the sweep's own behaviour is exercised; the off case
	// has its own test below.
	refreshEnabled: true,
	sheetsEnabled: true,
	sheetTabName: null,
	disabledAt: null,
	disabledByName: null,
	lastEditedBy: 'migration',
	lastEditedByName: 'migration',
	lastEditedAt: '2026-09-30T00:00:00.000Z',
};

/** The per-campaign half of a response: everything but the ledger counts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are read loosely, as `res.json()` always was here
async function campaignOf(res: Response): Promise<Record<string, any>> {
	return (await res.json()).campaigns[0];
}

/** The cross-campaign half: reconciliation, alerts, the Packet Tracker — run
 *  once per request, after the campaigns (runSharedStages). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as campaignOf
async function sharedOf(res: Response): Promise<Record<string, any>> {
	return (await res.json()).shared;
}

/** A campaign's catalog lock is held elsewhere; the ledger's is free. */
function campaignLockHeld(): void {
	mockAcquire.mockImplementation(async (_db: unknown, name: string) =>
		name === 'van-ledger' ? 'ledger-token' : null,
	);
}

describe('POST /api/internal/van-sync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mockPlace.mockResolvedValue(PLACED);
		mockEnv.INTERNAL_CRON_SECRET = 'cron-secret';
		mockVanClient.mockReturnValue({ ok: true, client: {} });
		mockAcquire.mockResolvedValue('lock-token');
		mockRunCatalogSync.mockResolvedValue(result);
		mockSettle.mockResolvedValue(0);
		mockReconcile.mockResolvedValue(reconcileResult);
		mockRefreshSweep.mockResolvedValue(refreshResult);
		mockDoorDeltas.mockResolvedValue(doorDeltaResult);
		mockDoorsHealth.mockResolvedValue(null);
		mockExportJobTypeId.mockReturnValue(5);
		mockRunGeometryQueue.mockResolvedValue(geometryResult);
		mockSweep.mockResolvedValue(0);
		mockWarn.mockResolvedValue({ sent: 0, failed: 0 });
		mockPrune.mockResolvedValue(0);
		mockDrift.mockResolvedValue(driftResult);
		mockListExpiry.mockResolvedValue({ announced: 0, failed: false, skipped: 'nothing-new' });
		mockHasher.mockReturnValue(null);
		mockRunContactStage.mockResolvedValue(null);
		mockEnsureCampaignRows.mockResolvedValue([]);
		mockCampaigns.mockResolvedValue([PRIMARY]);
		mockLoadCampaign.mockResolvedValue(PRIMARY);
		mockSeveral.mockResolvedValue(false);
		mockRecordFailure.mockResolvedValue(true);
		mockPostAlert.mockResolvedValue(true);
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

	it('records new campaign secrets even when the primary campaign is unconfigured', async () => {
		mockVanClient.mockReturnValue({ ok: false, error: 'VAN_API_KEY is not set' });
		mockEnsureCampaignRows.mockResolvedValue(['other']);
		await POST(event());
		expect(mockEnsureCampaignRows).toHaveBeenCalledOnce();
	});

	it('does not fail the sync when campaign discovery throws', async () => {
		mockEnsureCampaignRows.mockRejectedValue(new Error('database is locked'));
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect(mockRunCatalogSync).toHaveBeenCalledOnce();
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
			claimsExpired: 2,
			expiryWarningsSent: 3,
			expiryWarningsFailed: 1,
			campaigns: [{ campaignId: 1, error: 'VAN_API_KEY is not set' }],
			shared: expect.any(Object),
		});
	});

	// An install that never set VAN up has always run quietly with a 500. A
	// campaign with NO secret is that case: recorded, not announced.
	it('records but does not announce a campaign with no secret at all', async () => {
		mockVanClient.mockReturnValue({ ok: false, missing: true, error: 'VAN_API_KEY is not set' });
		await POST(event());
		expect(mockRecordFailure).toHaveBeenCalledWith({}, 1, 'VAN_API_KEY is not set');
		expect(mockPostAlert).not.toHaveBeenCalled();
	});

	// A malformed secret will be malformed next run too: a person has to fix it.
	it('announces a malformed secret once, and stamps it as announced', async () => {
		mockVanClient.mockReturnValue({ ok: false, error: 'VAN_CAMPAIGN_PRIMARY is not valid JSON' });
		await POST(event());
		expect(mockPostAlert).toHaveBeenCalledOnce();
		expect(mockPostAlert.mock.calls[0]![1]).toContain('VAN_CAMPAIGN_PRIMARY is not valid JSON');
		expect(mockMarkAnnounced).toHaveBeenCalledWith({}, 1, 'VAN_CAMPAIGN_PRIMARY is not valid JSON');
	});

	it('does not announce a failure that was already announced', async () => {
		mockVanClient.mockReturnValue({ ok: false, error: 'VAN_CAMPAIGN_PRIMARY is not valid JSON' });
		mockRecordFailure.mockResolvedValue(false);
		await POST(event());
		expect(mockPostAlert).not.toHaveBeenCalled();
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
		expect(mockRelease).toHaveBeenCalledWith({}, 'van-catalog-sync:1', 'lock-token');
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

	// The week-at-most promise for turf notices kept for Google holders rests
	// on this running every tick, read or not (spec 013, User Story 5).
	it('prunes old turf notices with the housekeeping, against the same clock', async () => {
		const order: string[] = [];
		mockWarn.mockImplementation(async () => {
			order.push('warn');
			return { sent: 0, failed: 0 };
		});
		mockPrune.mockImplementation(async () => {
			order.push('prune');
			return 2;
		});
		await POST(event());
		expect(mockPrune).toHaveBeenCalledOnce();
		expect(mockPrune.mock.calls[0]![1]).toBe(mockSweep.mock.calls[0]![1]);
		expect(order).toEqual(['warn', 'prune']);
	});

	it('does not let a failed prune fail the sync', async () => {
		mockPrune.mockRejectedValue(new Error('db down'));
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect(mockRunCatalogSync).toHaveBeenCalled();
	});

	it('leaves the prune to the next tick when another request holds the ledger', async () => {
		mockAcquire.mockImplementation(async (_db: unknown, name: string) =>
			name === 'van-ledger' ? null : 'lock-token',
		);
		await POST(event());
		expect(mockSweep).not.toHaveBeenCalled();
		expect(mockPrune).not.toHaveBeenCalled();
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
			claimsExpired: 0,
			expiryWarningsSent: 0,
			expiryWarningsFailed: 0,
			campaigns: [
				{
					campaignId: 1,
					...result,
					newTurfGeometry: geometryResult,
					geometry: geometryResult,
					placement: PLACED,
					refreshesSettled: 0,
					refresh: refreshResult,
					contacts: { disabled: true },
				},
			],
			shared: {
				reconciled: reconcileResult,
				doorDeltas: doorDeltaResult,
				doorsWarning: null,
				drift: driftResult,
				listExpiry: { announced: 0, failed: false, skipped: 'nothing-new' },
			},
		});
		expect(mockRunCatalogSync).toHaveBeenCalledWith(
			{},
			{},
			1,
			[{ chapterId: 71, chapterName: 'Washtenaw County', folderIds: [2731] }],
			// The catalog is capped below the workflow's `curl --max-time 300`
			// so geometry has room to run inside the same request.
			{ timeBudgetMs: 3 * 60 * 1000, roster: false },
		);
		expect(mockRelease).toHaveBeenCalledWith({}, 'van-catalog-sync:1', 'lock-token');
	});

	// Requested turf shaped since the last run goes to its chapter, with the
	// chapters the turf pickers offer.
	// Placement goes by a turf's location, so requested turf shaped on this
	// run is placed on this run, not the next one half an hour later.
	it('places the campaign’s requested turf after the new-turf shapes, before the rest', async () => {
		const order: string[] = [];
		mockPlace.mockImplementation(async () => {
			order.push('place');
			return PLACED;
		});
		mockRunGeometryQueue.mockImplementation(async (_db, _client, options) => {
			order.push(options.unmappedOnly ? 'new turf' : 'geometry');
			return geometryResult;
		});
		await POST(event());
		expect(mockPlace).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ id: 1 }),
			expect.objectContaining({ chapters: [{ chapterId: 71, name: 'Washtenaw County' }] }),
		);
		expect(order).toEqual(['new turf', 'place', 'geometry']);
	});

	// Later, the catalog and the contact counts could leave it nothing.
	it('places straight after the catalog, before the contact counts', async () => {
		const order: string[] = [];
		mockPlace.mockImplementation(async () => {
			order.push('place');
			return PLACED;
		});
		mockRunContactStage.mockImplementation(async () => {
			order.push('contacts');
			return null;
		});
		await POST(event());
		expect(order).toEqual(['place', 'contacts']);
	});

	// A run that ran out of time having placed nothing is the one most worth
	// seeing in the logs.
	it('logs a placement that ran out of time, though it placed nothing', async () => {
		const log = vi.spyOn(console, 'log');
		mockPlace.mockResolvedValue({ ...PLACED, byZip: 0, byNearby: 0, budgetLapsed: true });
		await POST(event());
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining('requested turf placed'),
			expect.objectContaining({ budgetLapsed: true }),
		);
	});

	// Said, not silent: a skip that left no trace is how a backlog of requested
	// turf sat unplaced run after run.
	it('warns when the catalog leaves no time to place requested turf', async () => {
		mockCampaigns.mockResolvedValue([{ ...PRIMARY, requestedFolderId: 900 }]);
		const realNow = Date.now;
		mockRunCatalogSync.mockImplementation(async () => {
			const later = realNow() + 10 * 60 * 1000;
			vi.spyOn(Date, 'now').mockImplementation(() => later);
			return result;
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await POST(event());
		expect(mockPlace).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('no time left to place'));
	});

	it('does not fail the sync when placement fails', async () => {
		mockPlace.mockRejectedValue(new Error('census down'));
		const res = await POST(event());
		expect(res.status).toBe(200);
		expect((await res.json()).campaigns[0].placement).toBeNull();
	});

	// The catalog writes `van_distributed_to`, which is VAN's half of the drift
	// comparison. Alerting first would announce drift computed against the
	// previous run's view of VAN — precisely the window an organizer's bulk export
	// lands in.
	it("alerts on drift only after the catalog has refreshed VAN's half, and after geometry", async () => {
		const order: string[] = [];
		mockRunCatalogSync.mockImplementation(async () => {
			order.push('catalog');
			return result;
		});
		mockDrift.mockImplementation(async () => {
			order.push('drift');
			return driftResult;
		});
		mockRunGeometryQueue.mockImplementation(async () => {
			order.push('geometry');
			return geometryResult;
		});
		await POST(event());
		// The shared stages follow every campaign's catalog and geometry; the
		// last campaign's geometry leaves them time (SHARED_RESERVE_MS).
		expect(order).toEqual(['catalog', 'geometry', 'geometry', 'drift']);
	});

	it('confirms in-flight refreshes against the regions the catalog just read', async () => {
		// The catalog read is the only place VAN's dateRefreshed appears, so the
		// confirmation rides on it rather than costing a second call.
		await POST(event());
		expect(mockSettle).toHaveBeenCalledWith({}, 1, result.regionsRead);
	});

	it('reconciles claims after the catalog and before the drift report', async () => {
		const order: string[] = [];
		mockRunCatalogSync.mockImplementation(async () => {
			order.push('catalog');
			return result;
		});
		mockSettle.mockImplementation(async () => {
			order.push('settle');
			return 0;
		});
		mockReconcile.mockImplementation(async () => {
			order.push('reconcile');
			return reconcileResult;
		});
		mockDoorDeltas.mockImplementation(async () => {
			order.push('deltas');
			return doorDeltaResult;
		});
		mockDrift.mockImplementation(async () => {
			order.push('drift');
			return driftResult;
		});
		mockRefreshSweep.mockImplementation(async () => {
			order.push('refresh');
			return refreshResult;
		});
		await POST(event());
		// The campaign's own stages first (catalog, confirming earlier re-cuts,
		// asking for new ones), then the shared ones: reconciliation repairs claims
		// a re-cut just released, the delta check must not measure those as
		// completions, and drift reads the ledger, so it has to see both.
		expect(order).toEqual(['catalog', 'settle', 'refresh', 'reconcile', 'deltas', 'drift']);
	});

	it('warns about expiring list numbers after the catalog, in the turf channel', async () => {
		// The catalog writes each list's creation date, so warning before it
		// would count from a list an organizer may have just replaced.
		const order: string[] = [];
		mockRunCatalogSync.mockImplementation(async () => {
			order.push('catalog');
			return result;
		});
		mockListExpiry.mockImplementation(async () => {
			order.push('list-expiry');
			return { announced: 2, failed: false };
		});
		const body = await sharedOf(await POST(event()));
		expect(order).toEqual(['catalog', 'list-expiry']);
		expect(mockListExpiry).toHaveBeenCalledWith(
			{},
			{ now: mockSweep.mock.calls[0]![1], channelId: 'C_TURF', appUrl: 'https://app.example' },
		);
		expect(body.listExpiry).toEqual({ announced: 2, failed: false });
	});

	it('reports what the sync-back check found', async () => {
		mockDoorDeltas.mockResolvedValue({
			measured: 4,
			unsynced: 1,
			doorsCleared: 212,
			dmFailed: 0,
		});
		const body = await sharedOf(await POST(event()));
		expect(body).toMatchObject({ doorDeltas: { measured: 4, unsynced: 1, doorsCleared: 212 } });
	});

	it('reconciles with the configured claim TTL, so a moved claim gets a normal window', async () => {
		await POST(event());
		expect(mockReconcile).toHaveBeenCalledWith(
			{},
			{
				now: mockSweep.mock.calls[0]![1],
				appUrl: 'https://app.example',
				ttlHours: 48,
				// The tracker's live check, so a handover never lands on turf it has out.
				sheetCheck: mockSheetCheck,
			},
		);
	});

	it('bounds the refresh sweep so it cannot eat the request', async () => {
		await POST(event());
		const { timeBudgetMs } = mockRefreshSweep.mock.calls[0]![3];
		expect(timeBudgetMs).toBeGreaterThan(0);
		expect(timeBudgetMs).toBeLessThanOrEqual(30 * 1000);
	});

	it('posts the turf-cutting health warning with the other notices', async () => {
		// Story 9.4: if regions are cut without a "not yet contacted" filter,
		// every doors number on the dashboard reads zero and looks like a bug in
		// this app. This is the only place that difference becomes visible.
		mockDoorsHealth.mockResolvedValue('5 completed turfs in a row cleared zero doors.');
		await POST(event());
		expect(mockPostMessage.mock.calls[0]![0].text as string).toContain('cleared zero doors');
	});

	it('survives a failed health check', async () => {
		mockDoorsHealth.mockRejectedValue(new Error('database is locked'));
		const res = await POST(event());
		expect(res.status).toBe(200);
	});

	it('sends no refresh while the switch is off, and says so', async () => {
		// A re-cut replaces every route in the region, and the replacements may
		// have no printed list — so with the switch off (the default) the sweep
		// must not run at all, not merely send fewer requests.
		mockCampaigns.mockResolvedValue([{ ...PRIMARY, refreshEnabled: false }]);
		const body = await campaignOf(await POST(event()));
		expect(mockRefreshSweep).not.toHaveBeenCalled();
		expect(body.refresh).toEqual({ disabled: true });
		// Confirming earlier refreshes makes no VAN call, so it still runs.
		expect(mockSettle).toHaveBeenCalled();
	});

	it('posts refresh warnings to the turf channel with the rest', async () => {
		mockRefreshSweep.mockResolvedValue({
			...refreshResult,
			warnings: ['Nightly refresh of folder 2731 failed: FORBIDDEN'],
		});
		await POST(event());
		expect(mockPostMessage.mock.calls[0]![0].text as string).toContain(
			'Nightly refresh of folder 2731 failed',
		);
	});

	it('reports what the reconciliation and the sweep did', async () => {
		mockReconcile.mockResolvedValue({ ...reconcileResult, listNumbersChanged: 2, walkedOut: 1 });
		mockRefreshSweep.mockResolvedValue({ ...refreshResult, regionsRefreshed: 3 });
		const body = await (await POST(event())).json();
		expect(body.shared).toMatchObject({ reconciled: { listNumbersChanged: 2, walkedOut: 1 } });
		expect(body.campaigns[0]).toMatchObject({ refresh: { regionsRefreshed: 3 } });
	});

	it('posts drift to the turf channel, against the housekeeping clock', async () => {
		await POST(event());
		expect(mockDrift).toHaveBeenCalledWith(
			{},
			{
				now: mockSweep.mock.calls[0]![1],
				channelId: 'C_TURF',
				appUrl: 'https://app.example',
			},
		);
	});

	// The shared stages need no VAN key: claims still need reconciling when a
	// key is broken. Drift guards
	// itself — it leaves out any campaign whose last sync failed, whose
	// `van_distributed_to` is stale (drift-store.ts).
	it('runs the shared stages even when the catalog could not', async () => {
		mockVanClient.mockReturnValue({ ok: false, error: 'VAN_API_KEY is not set' });
		await POST(event());
		expect(mockReconcile).toHaveBeenCalledOnce();
		expect(mockDrift).toHaveBeenCalledOnce();
	});

	// The scheduler's earlier calls of a tick: the last one runs them.
	it('leaves the shared stages out with shared=0', async () => {
		const body = await (await POST(event('cron-secret', '&shared=0'))).json();
		expect(mockReconcile).not.toHaveBeenCalled();
		expect(mockDrift).not.toHaveBeenCalled();
		expect(body.shared).toBeUndefined();
		expect(body.campaigns[0].turfsUpserted).toBe(3);
	});

	it('skips the shared stages when another request holds the ledger lock', async () => {
		let ledgerTaken = 0;
		mockAcquire.mockImplementation(async (_db: unknown, name: string) =>
			name === 'van-ledger' ? (ledgerTaken++ === 0 ? 'ledger-token' : null) : 'lock-token',
		);
		const body = await (await POST(event())).json();
		expect(mockReconcile).not.toHaveBeenCalled();
		expect(body.shared).toEqual({ skipped: 'another request is running them' });
	});

	it('reports what the drift alert did', async () => {
		mockDrift.mockResolvedValue({ announced: 3, cleared: 1, failed: false });
		const body = await sharedOf(await POST(event()));
		expect(body).toMatchObject({ drift: { announced: 3, cleared: 1, failed: false } });
	});

	describe('when another sync holds the lock', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		/** POST, letting the lock wait's polls elapse. */
		async function postWaiting() {
			const pending = POST(event());
			await vi.advanceTimersByTimeAsync(80 * 1000);
			return pending;
		}

		// Placement needs neither VAN nor this lock, and a drain or webhook can
		// hold it for run after run.
		it('still places requested turf when it skips', async () => {
			campaignLockHeld();
			mockPlace.mockResolvedValue(PLACED);
			const res = await postWaiting();
			expect(mockPlace).toHaveBeenCalledWith(
				{},
				expect.objectContaining({ id: 1 }),
				expect.anything(),
			);
			expect((await campaignOf(res)).placement).toEqual(PLACED);
		});

		it('skips without error once the wait runs out', async () => {
			campaignLockHeld();
			const res = await postWaiting();
			expect(res.status).toBe(200);
			expect((await campaignOf(res)).skipped).toBeTruthy();
			expect(mockRunCatalogSync).not.toHaveBeenCalled();
			// Nothing to release for the campaign; the ledger lock was taken
			// and released as normal.
			expect(mockRelease).not.toHaveBeenCalledWith({}, 'van-catalog-sync:1', expect.anything());
			expect(mockRelease).toHaveBeenCalledWith({}, 'van-ledger', 'ledger-token');
		});

		// A command-line drain lets go between slices; the sync gets in then
		// rather than skipping every tick for the hours a drain runs.
		it('waits for the lock and runs the sync when it frees', async () => {
			mockAcquire
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(null)
				.mockResolvedValue('lock-token');
			const res = await postWaiting();
			expect(res.status).toBe(200);
			expect(mockRunCatalogSync).toHaveBeenCalledOnce();
			expect(mockRelease).toHaveBeenCalledWith({}, 'van-catalog-sync:1', 'lock-token');
		});

		// A drain pauses between slices only while this marker says a sync is
		// waiting; held for the wait, let go once the lock is had.
		it('says it is waiting while it waits, and stops saying so after', async () => {
			let campaignTries = 0;
			mockAcquire.mockImplementation(async (_db: unknown, name: string) => {
				if (name === 'van-ledger') return 'ledger-token';
				if (name === 'van-catalog-sync-waiting:1') return 'waiting-token';
				return campaignTries++ < 2 ? null : 'lock-token';
			});
			const res = await postWaiting();
			expect(res.status).toBe(200);
			expect(mockRunCatalogSync).toHaveBeenCalledOnce();
			const names = mockAcquire.mock.calls.map((c) => c[1]);
			expect(names.filter((n) => n === 'van-catalog-sync-waiting:1')).toHaveLength(1);
			// Taken after the first try fails, not before.
			expect(names.indexOf('van-catalog-sync-waiting:1')).toBe(
				names.indexOf('van-catalog-sync:1') + 1,
			);
			expect(mockRelease).toHaveBeenCalledWith({}, 'van-catalog-sync-waiting:1', 'waiting-token');
		});

		it('does not say it is waiting when the lock is free', async () => {
			mockAcquire.mockResolvedValue('lock-token');
			await POST(event());
			expect(mockAcquire.mock.calls.map((c) => c[1])).not.toContain('van-catalog-sync-waiting:1');
		});

		// The counts have their own lock; a drain must not freeze them.
		it('still pulls contacts when it has to skip', async () => {
			campaignLockHeld();
			mockRunContactStage.mockResolvedValue({ windowsApplied: 1 });
			const body = await campaignOf(await postWaiting());
			expect(mockRunContactStage).toHaveBeenCalledOnce();
			expect(body.contacts).toMatchObject({ windowsApplied: 1 });
		});
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
		expect((await res.json()).campaigns).toEqual([
			{ campaignId: 1, error: 'VAN /folders returned 500' },
		]);
		expect(mockRelease).toHaveBeenCalledWith({}, 'van-catalog-sync:1', 'lock-token');
	});

	describe('uncontacted doors', () => {
		it('queues roster exports only when the hash secret is configured', async () => {
			mockHasher.mockReturnValue({ person: () => Buffer.alloc(16), door: () => Buffer.alloc(16) });
			await POST(event());

			expect(mockRunCatalogSync.mock.calls[0]![4]).toMatchObject({ roster: true });
			expect(mockRunGeometryQueue.mock.calls[0]![2].roster).not.toBeNull();
		});

		it('recomputes every turf after the catalog and before geometry', async () => {
			await POST(event());

			expect(mockRunContactStage).toHaveBeenCalledOnce();
			const [, campaign, options] = mockRunContactStage.mock.calls[0]!;
			// The whole campaign, not a nudge's handful of turf.
			expect(campaign).toBe(PRIMARY);
			expect(options.turfIds).toBeUndefined();
			const stage = mockRunContactStage.mock.invocationCallOrder[0]!;
			expect(mockRunCatalogSync.mock.invocationCallOrder[0]).toBeLessThan(stage);
			// The full run; turf not on the map yet goes before it.
			expect(stage).toBeLessThan(mockRunGeometryQueue.mock.invocationCallOrder[1]!);
		});

		it('reports what it did, or that it is off', async () => {
			expect((await campaignOf(await POST(event()))).contacts).toEqual({ disabled: true });

			mockRunContactStage.mockResolvedValue({ windowsApplied: 2, turfsRecomputed: 9 });
			expect((await campaignOf(await POST(event()))).contacts).toMatchObject({
				windowsApplied: 2,
			});
		});

		// The counts are an overlay on doorCount; the catalog is already written.
		it('never fails the sync', async () => {
			mockRunContactStage.mockRejectedValue(new Error('turso hiccup'));
			const res = await POST(event());

			expect(res.status).toBe(200);
			expect(mockRunGeometryQueue).toHaveBeenCalled();
		});
	});

	// Its own job (packet-tracker-sync): run here, last, a slow VAN call left
	// it no time at all.
	it('leaves the Packet Tracker to its own job', async () => {
		await POST(event());
		expect(mockRunPacketTracker).not.toHaveBeenCalled();
	});

	describe('geometry', () => {
		// The shared stages follow the last campaign's geometry, so it leaves
		// them their slice — but only on the request that runs them.
		it('leaves time for the shared stages only when this request runs them', async () => {
			await POST(event());
			const withShared = mockRunGeometryQueue.mock.calls[1]![2].timeBudgetMs;
			mockRunGeometryQueue.mockClear();
			await POST(event('cron-secret', '&shared=0'));
			const without = mockRunGeometryQueue.mock.calls[1]![2].timeBudgetMs;
			expect(without - withShared).toBeGreaterThanOrEqual(10 * 1000);
		});

		it('drains the queue after the catalog and reports what it did', async () => {
			const res = await POST(event());
			const body = await campaignOf(res);

			expect(mockRunGeometryQueue).toHaveBeenCalledTimes(2);
			expect(body.newTurfGeometry.hullsStored).toBe(3);
			expect(body.geometry.hullsStored).toBe(3);
			// The catalog must be written before geometry runs — a turf cut
			// minutes ago should get its shape on this run, not the next.
			expect(mockRunCatalogSync.mock.invocationCallOrder[0]).toBeLessThan(
				mockRunGeometryQueue.mock.invocationCallOrder[0],
			);
		});

		// What an organizer just cut is what someone is waiting to see. The
		// contact pull and the refresh sweep could leave the full run at the
		// end nothing, run after run, so new turf gets its own slice first.
		it('shapes turf not on the map yet before the other stages, in a short slice', async () => {
			await POST(event());
			const [first, second] = mockRunGeometryQueue.mock.calls.map((c) => c[2]);
			expect(first.unmappedOnly).toBe(true);
			expect(first.timeBudgetMs).toBeLessThanOrEqual(45 * 1000);
			expect(second.unmappedOnly).toBe(false);
			const newTurf = mockRunGeometryQueue.mock.invocationCallOrder[0]!;
			expect(mockRunCatalogSync.mock.invocationCallOrder[0]).toBeLessThan(newTurf);
			expect(newTurf).toBeLessThan(mockRefreshSweep.mock.invocationCallOrder[0]!);
		});

		// VAN stores this URL against the export job and echoes it back on every
		// later read, so what it carries is a disclosure decision. It must be a
		// per-turf HMAC and NEVER INTERNAL_CRON_SECRET, which also opens the
		// catalog sync, both snapshots, the mobilize sync, the invite audit and
		// the growth report.
		it('registers a per-turf webhook url on our own host, without the cron key', async () => {
			await POST(event());
			const options = mockRunGeometryQueue.mock.calls[0]![2];
			const url = new URL(options.webhookUrlFor(100));

			expect(url.origin).toBe('https://app.example');
			expect(url.pathname).toBe('/api/internal/van-export-callback');
			expect(url.searchParams.get('turf')).toBe('100');
			expect(url.searchParams.get('token')).toMatch(/^[0-9a-f]{32}$/);
			expect(url.searchParams.get('key')).toBeNull();
			expect(options.webhookUrlFor(100)).not.toContain('cron-secret');
			// A token that did not depend on the turf would be a shared secret
			// wearing a different name.
			expect(options.webhookUrlFor(101)).not.toBe(options.webhookUrlFor(100));
			expect(options.exportJobTypeId).toBe(5);
		});

		// The route deliberately says nothing about geocoding: the worker
		// defaults to the Census geocoder, and passing an explicit `null` here
		// would silently disable it for the scheduled sync only.
		it('leaves the geocoder to the worker default', async () => {
			await POST(event());
			expect(mockRunGeometryQueue.mock.calls[0]![2]).not.toHaveProperty('geocode');
		});

		it('skips geometry, but still syncs the catalog, with no export job type set', async () => {
			mockExportJobTypeId.mockReturnValue(null);
			const res = await POST(event());
			const body = await campaignOf(res);

			expect(mockRunGeometryQueue).not.toHaveBeenCalled();
			// Null rather than zeros, so "not configured" stays distinguishable
			// from "ran and found nothing to do".
			expect(body.geometry).toBeNull();
			expect(body.turfsUpserted).toBe(3);
			expect(res.status).toBe(200);
		});

		// Geometry is decoration; the catalog rows are already written and
		// correct by the time it runs.
		it('still returns the catalog result when the geometry queue throws', async () => {
			mockRunGeometryQueue.mockRejectedValue(new Error('VAN is down'));
			const res = await POST(event());
			const body = await campaignOf(res);

			expect(res.status).toBe(200);
			expect(body.turfsUpserted).toBe(3);
			expect(body.geometry).toBeNull();
		});

		// The worker posts dead letters itself, through the `alert` this route
		// hands it. Repeating them in the notices message put every one of them
		// in the channel twice.
		it('posts advisory geometry warnings but leaves dead letters to the worker alert', async () => {
			mockRunGeometryQueue.mockResolvedValue({
				...geometryResult,
				deadLettered: 1,
				deadLetters: ['Turf 100 geometry gave up after 4 attempt(s): boom'],
				warnings: ['Turf 101: addresses span ~58 km, far past a walkable turf.'],
			});
			await POST(event());

			expect(mockPostMessage).toHaveBeenCalledOnce();
			const text = mockPostMessage.mock.calls[0]![0].text;
			expect(text).toContain('far past a walkable turf');
			expect(text).not.toContain('gave up after');
		});

		// The workflow calls this with `curl --max-time 300`. Taking the deadline
		// after the ledger housekeeping would let the request run for that
		// housekeeping PLUS the whole budget.
		it('starts the request budget before the ledger housekeeping, not after', async () => {
			const SWEEP_MS = 40;
			mockSweep.mockImplementation(
				async () => new Promise((r) => setTimeout(() => r(0), SWEEP_MS)),
			);
			await POST(event());

			const { timeBudgetMs } = mockRunGeometryQueue.mock.calls.at(-1)![2];
			// A budget stamped after the sweep would still be the full 4m30s.
			// Stamped before it, the sweep has already come out of it.
			expect(timeBudgetMs).toBeLessThanOrEqual(4 * 60 * 1000 + 30 * 1000 - SWEEP_MS / 2);
		});
	});

	// specs/012-multi-van-campaigns: each campaign is synced with its own key,
	// under its own lock, and one failing never stops another.
	describe('several campaigns', () => {
		const OTHER = {
			...PRIMARY,
			id: 2,
			credentialKey: 'other',
			label: 'El-Sayed',
			refreshEnabled: false,
			sheetsEnabled: false,
		};

		beforeEach(() => {
			mockCampaigns.mockResolvedValue([OTHER, PRIMARY]);
			mockSeveral.mockResolvedValue(true);
			mockLoadCampaign.mockImplementation(async (_db: unknown, id: number) =>
				id === 2 ? OTHER : id === 1 ? PRIMARY : null,
			);
		});

		it('syncs every enabled campaign in the order given, each with its own key and lock', async () => {
			const res = await POST(event());
			expect(res.status).toBe(200);
			expect(mockVanClient.mock.calls.map((c) => c[0])).toEqual([OTHER, PRIMARY]);
			expect(mockRunCatalogSync.mock.calls.map((c) => c[2])).toEqual([2, 1]);
			// The ledger lock twice: the housekeeping first, the shared stages last.
			expect(mockAcquire.mock.calls.map((c) => c[1])).toEqual([
				'van-ledger',
				'van-catalog-sync:2',
				'van-catalog-sync:1',
				'van-ledger',
			]);
			const body = await res.json();
			expect(body.campaigns.map((c: { campaignId: number }) => c.campaignId)).toEqual([2, 1]);
		});

		// Run per campaign, they did the same work once per campaign: the doors
		// warning posted under each campaign's name.
		it('runs the shared stages once, after every campaign', async () => {
			await POST(event());
			expect(mockReconcile).toHaveBeenCalledOnce();
			expect(mockDoorsHealth).toHaveBeenCalledOnce();
			const lastCatalog = Math.max(...mockRunCatalogSync.mock.invocationCallOrder);
			expect(mockReconcile.mock.invocationCallOrder[0]).toBeGreaterThan(lastCatalog);
		});

		it('syncs only the campaign named, after the ledger housekeeping', async () => {
			await POST(event('cron-secret', '&campaign=2'));
			expect(mockSweep).toHaveBeenCalledOnce();
			expect(mockRunCatalogSync).toHaveBeenCalledOnce();
			expect(mockRunCatalogSync.mock.calls[0]![2]).toBe(2);
			expect(mockLoadVanChapterFolders).toHaveBeenCalledWith({}, 2);
		});

		it('keeps going past a campaign that fails, and reports the failure', async () => {
			mockVanClient.mockImplementation((c: { id: number }) =>
				c.id === 2
					? { ok: false, error: 'VAN_CAMPAIGN_OTHER is not set', missing: true }
					: { ok: true, client: {} },
			);
			const res = await POST(event());
			expect(res.status).toBe(500);
			expect(mockRunCatalogSync).toHaveBeenCalledOnce();
			expect(mockRunCatalogSync.mock.calls[0]![2]).toBe(1);
			const body = await res.json();
			expect(body.campaigns[0]).toEqual({ campaignId: 2, error: 'VAN_CAMPAIGN_OTHER is not set' });
			expect(body.campaigns[1].turfsUpserted).toBe(3);
		});

		// A partner campaign that has not agreed to re-cuts must never get one,
		// whatever the primary campaign's switch says. Off is the default.
		it('never sends a region refresh for a campaign whose own switch is off', async () => {
			await POST(event('cron-secret', '&campaign=2'));
			expect(mockRefreshSweep).not.toHaveBeenCalled();
			expect((await campaignOf(await POST(event('cron-secret', '&campaign=2')))).refresh).toEqual({
				disabled: true,
			});
		});

		// The switch is the campaign's own: a partner that has agreed gets re-cuts
		// with its own key, primary or not.
		it('sends region refreshes for any campaign whose switch is on', async () => {
			mockLoadCampaign.mockResolvedValue({ ...OTHER, refreshEnabled: true });
			await POST(event('cron-secret', '&campaign=2'));
			expect(mockRefreshSweep).toHaveBeenCalledOnce();
			expect(mockRefreshSweep.mock.calls[0]![2]).toBe(2);
		});

		it('names the campaign in its notices, so the channel can tell them apart', async () => {
			mockRunCatalogSync.mockResolvedValue({ ...result, warnings: ['2 turf(s) have no number'] });
			await POST(event('cron-secret', '&campaign=2'));
			expect(mockPostMessage.mock.calls[0]![0].text).toContain('[van · El-Sayed]');
		});

		it('names an unnamed campaign by its key', async () => {
			mockLoadCampaign.mockResolvedValue({ ...OTHER, label: null });
			mockRunCatalogSync.mockResolvedValue({ ...result, warnings: ['2 turf(s) have no number'] });
			await POST(event('cron-secret', '&campaign=2'));
			expect(mockPostMessage.mock.calls[0]![0].text).toContain('[van · other]');
		});

		it('skips a disabled campaign but still does the housekeeping', async () => {
			mockLoadCampaign.mockResolvedValue({ ...OTHER, enabled: false });
			const res = await POST(event('cron-secret', '&campaign=2'));
			expect(res.status).toBe(200);
			expect((await res.json()).skipped).toBe('campaign is disabled');
			expect(mockSweep).toHaveBeenCalledOnce();
			expect(mockRunCatalogSync).not.toHaveBeenCalled();
		});

		// The scheduler syncs campaigns at once, each with `shared=0`, then asks
		// for the shared stages on their own once every catalog has landed.
		it('runs only the housekeeping and the shared stages for shared=only', async () => {
			const res = await POST(event('cron-secret', '&shared=only'));
			expect(res.status).toBe(200);
			expect(mockRunCatalogSync).not.toHaveBeenCalled();
			expect(mockSweep).toHaveBeenCalledOnce();
			expect(mockReconcile).toHaveBeenCalledOnce();
			const body = await res.json();
			expect(body.campaigns).toEqual([]);
			expect(body.shared.reconciled).toEqual(reconcileResult);
		});

		// The in-app scheduler waits longer than the workflow's curl, so its
		// catalog gets the time to read every folder.
		it('gives the catalog more time on budget=long', async () => {
			await POST(event('cron-secret', '&campaign=1'));
			const usual = mockRunCatalogSync.mock.calls[0]![4].timeBudgetMs;
			mockRunCatalogSync.mockClear();
			await POST(event('cron-secret', '&campaign=1&budget=long'));
			const long = mockRunCatalogSync.mock.calls[0]![4].timeBudgetMs;
			expect(usual).toBeLessThanOrEqual(3 * 60 * 1000);
			expect(long).toBeGreaterThan(4 * 60 * 1000);
			expect(long).toBeLessThanOrEqual(5 * 60 * 1000);
		});

		it('answers 404 for a campaign that does not exist, and 400 for nonsense', async () => {
			expect((await POST(event('cron-secret', '&campaign=99'))).status).toBe(404);
			expect((await POST(event('cron-secret', '&campaign=abc'))).status).toBe(400);
			expect((await POST(event('cron-secret', '&campaign=0'))).status).toBe(400);
		});
	});
});

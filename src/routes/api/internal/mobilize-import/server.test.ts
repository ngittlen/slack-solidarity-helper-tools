import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyImportReport } from '../../../../../mobilize-migrator/lib/import.js';

const mockRun = vi.hoisted(() => vi.fn());
const alerts = vi.hoisted(() => [] as string[]);
const lockHeld = vi.hoisted(() => ({ value: false }));

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/env.js', () => ({
	INTERNAL_CRON_SECRET: 'cron-secret',
	SOLIDARITY_API_TOKEN: 'sol-token',
}));
vi.mock('$lib/server/mobilize-import.js', () => ({ runMobilizeImport: mockRun }));
vi.mock('$lib/server/slack.js', () => ({
	alertForMobilizeSync: async () => async (text: string) => {
		alerts.push(text);
	},
}));
vi.mock('$lib/server/sync-lock.js', () => ({
	withSyncLock: async (_db: unknown, _name: string, _ttl: number, fn: () => Promise<unknown>) =>
		lockHeld.value ? { skipped: true } : { skipped: false, result: await fn() },
}));

const { POST } = await import('./+server.js');

function post(query = '') {
	const url = new URL(`http://localhost/api/internal/mobilize-import?key=cron-secret${query}`);
	return POST({ url } as never) as Promise<Response>;
}

function result(overrides: Record<string, unknown> = {}) {
	return {
		...emptyImportReport(),
		configured: true,
		mobilizeAuthFailed: false,
		skippedNotPublic: 0,
		skippedNotOwned: 0,
		dryRun: false,
		...overrides,
	};
}

beforeEach(() => {
	mockRun.mockReset();
	alerts.length = 0;
	lockHeld.value = false;
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/internal/mobilize-import', () => {
	it('rejects a wrong key without running', async () => {
		const url = new URL('http://localhost/api/internal/mobilize-import?key=nope');
		const res = (await POST({ url } as never)) as Response;
		expect(res.status).toBe(401);
		expect(mockRun).not.toHaveBeenCalled();
	});

	it('rejects a junk maxCreates rather than lifting the limit', async () => {
		expect((await post('&maxCreates=all')).status).toBe(400);
		expect(mockRun).not.toHaveBeenCalled();
	});

	it('passes dry, maxCreates and budgetMs through', async () => {
		mockRun.mockResolvedValue(result({ dryRun: true }));
		await post('&dry=1&maxCreates=3&budgetMs=5000');
		expect(mockRun).toHaveBeenCalledWith({}, { apply: false, maxCreates: 3, budgetMs: 5000 });
	});

	it('answers 200 and stays quiet when another run holds the lock', async () => {
		lockHeld.value = true;
		const res = await post();
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ skipped: true });
		expect(alerts).toEqual([]);
	});

	it('answers 200 and stays quiet when not configured', async () => {
		mockRun.mockResolvedValue({ configured: false, reason: 'no import tag set on /settings' });
		const res = await post();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ skipped: true, reason: 'no import tag set on /settings' });
		expect(alerts).toEqual([]);
	});

	it('announces new imports with links, and names default-chapter fallbacks', async () => {
		mockRun.mockResolvedValue(
			result({
				created: 2,
				createdEvents: [
					{ title: 'Canvass', pageUrl: 'https://p/1', usedFallbackScope: false },
					{ title: 'Phonebank', pageUrl: null, usedFallbackScope: true },
				],
				fallbackScope: ['Phonebank'],
			}),
		);
		const res = await post();
		expect(res.status).toBe(200);
		expect(alerts).toHaveLength(2);
		expect(alerts[0]).toContain('imported 2');
		expect(alerts[0]).toContain('<https://p/1|Canvass>');
		expect(alerts[0]).toContain('• new: Phonebank');
		expect(alerts[1]).toContain('default chapter');
		expect(alerts[1]).toContain('Phonebank');
	});

	it('posts nothing for a dry run, even with things it would do', async () => {
		mockRun.mockResolvedValue(
			result({ dryRun: true, wouldCreate: ['Canvass'], fallbackScope: ['Canvass'] }),
		);
		expect((await post('&dry=1')).status).toBe(200);
		expect(alerts).toEqual([]);
	});

	it('alerts and answers 503 when the partner key is rejected', async () => {
		mockRun.mockResolvedValue(result({ mobilizeAuthFailed: true }));
		expect((await post()).status).toBe(503);
		expect(alerts[0]).toContain('their Mobilize rejected the API key');
	});

	it('alerts and answers 503 when Solidarity rejects the token', async () => {
		mockRun.mockResolvedValue(result({ authFailed: true, errors: ['"X": 401'] }));
		expect((await post()).status).toBe(503);
		expect(alerts[0]).toContain('Solidarity rejected the API token');
	});

	it('on a guardrail stop, says so and still reports what it finished', async () => {
		mockRun.mockResolvedValue(
			result({
				abortedReason: '30 new events to import exceeds the limit of 10 per run.',
				resumed: 1,
			}),
		);
		expect((await post()).status).toBe(503);
		expect(alerts[0]).toContain('held back new events');
		expect(alerts[1]).toContain('finished 1 from an earlier run');
	});

	it('raises unconfirmed creates, rejections, stalls, duplicates and failures', async () => {
		mockRun.mockResolvedValue(
			result({
				unconfirmed: ['U'],
				rejected: [
					{ title: 'R', solidarityEventId: null },
					{ title: 'R2', solidarityEventId: 900 },
				],
				newlyStalled: ['S'],
				stalled: ['S', 'S2'],
				duplicates: ['D'],
				failed: 1,
				errors: ['"F": boom'],
			}),
		);
		expect((await post()).status).toBe(200);
		const all = alerts.join('\n');
		expect(all).toContain("didn't say what it created");
		expect(all).toContain('gave up on 2 event');
		expect(all).toContain('• R — not imported');
		expect(all).toContain('• R2 — *already in Solidarity* as event 900');
		expect(all).toContain('can no longer be finished');
		expect(all).toContain('• S');
		expect(all).not.toContain('• S2');
		expect(all).toContain('refused 1 event(s) as duplicates');
		expect(all).toContain('earlier attempt of this same import');
		expect(all).toContain('• D');
		expect(all).toContain('"F": boom');
	});

	it('alerts and answers 500 when the run throws', async () => {
		mockRun.mockRejectedValue(new Error('SOLIDARITY_DEFAULT_CHAPTER_ID is not set'));
		expect((await post()).status).toBe(500);
		expect(alerts[0]).toContain('SOLIDARITY_DEFAULT_CHAPTER_ID is not set');
	});
});

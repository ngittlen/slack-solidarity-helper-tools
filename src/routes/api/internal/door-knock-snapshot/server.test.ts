import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockRunSnapshot = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockBeginRefresh = vi.hoisted(() => vi.fn());
const mockEndRefresh = vi.hoisted(() => vi.fn());
const mockDoorKnockProvider = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({ INTERNAL_CRON_SECRET: 'test-cron-secret' }));

vi.mock('$lib/server/door-knock-snapshot', () => ({ runDoorKnockSnapshot: mockRunSnapshot }));
// Provider selection and its env validation are door-knock-env's job (and its
// own test's) — this route only cares that a provider is or isn't available.
vi.mock('$lib/server/door-knock-env', () => ({ doorKnockProvider: mockDoorKnockProvider }));
vi.mock('$lib/server/slack', () => ({ slack: { chat: { postMessage: mockPostMessage } } }));
vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/door-knock-refresh', () => ({
	beginDoorKnockRefresh: mockBeginRefresh,
	endDoorKnockRefresh: mockEndRefresh,
}));
vi.mock('$lib/server/env', () => ({
	get INTERNAL_CRON_SECRET() {
		return mockEnv.INTERNAL_CRON_SECRET;
	},
}));

function makeReq(query: string) {
	return { url: new URL(`http://localhost/api/internal/door-knock-snapshot${query}`) };
}

const OK_RESULT = {
	provider: 'openfield',
	date: '2026-07-06',
	rowsWritten: 2,
	canvasserRowsWritten: 3,
	totalAttempts: 42,
	warnings: [],
	details: { codesFound: 2, codesFailed: [] },
};

describe('POST /api/internal/door-knock-snapshot', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDoorKnockProvider.mockReturnValue({ ok: true, provider: { name: 'openfield' } });
		mockRunSnapshot.mockResolvedValue(OK_RESULT);
		mockPostMessage.mockResolvedValue({ ok: true });
		mockLoadSettings.mockResolvedValue({ slackTrackingChannelId: 'C_TRACK' });
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('returns 401 when the key is missing or wrong', async () => {
		expect((await POST(makeReq('') as never)).status).toBe(401);
		expect((await POST(makeReq('?key=wrong') as never)).status).toBe(401);
		expect(mockRunSnapshot).not.toHaveBeenCalled();
	});

	it('returns 500 with the provider config error when no provider is available', async () => {
		mockDoorKnockProvider.mockReturnValue({
			ok: false,
			error: 'OPENFIELD_BASE_URL/USERNAME/PASSWORD are not set',
		});
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(500);
		expect((await res.json()).error).toMatch(/OPENFIELD/);
		expect(mockRunSnapshot).not.toHaveBeenCalled();
	});

	it('runs the snapshot with the configured provider and returns its result', async () => {
		const provider = { name: 'openfield' };
		mockDoorKnockProvider.mockReturnValue({ ok: true, provider });

		const res = await POST(makeReq('?key=test-cron-secret') as never);

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ date: '2026-07-06', totalAttempts: 42 });
		expect(mockRunSnapshot).toHaveBeenCalledTimes(1);
		expect(mockRunSnapshot.mock.calls[0]![1]).toBe(provider);
	});

	// The scheduled run resets the dashboard's on-demand refresh window, so a
	// visit right after the cron doesn't re-fetch the same numbers.
	it('stamps the refresh window around a successful run', async () => {
		await POST(makeReq('?key=test-cron-secret') as never);
		expect(mockBeginRefresh).toHaveBeenCalledTimes(1);
		expect(mockEndRefresh).toHaveBeenCalledTimes(1);
		expect(mockEndRefresh.mock.calls[0]![2]).toBeNull();
	});

	it('records the failure on the refresh window when the snapshot throws', async () => {
		mockRunSnapshot.mockRejectedValueOnce(new Error('openfield 503'));
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(500);
		expect(mockEndRefresh.mock.calls[0]![2]).toBe('openfield 503');
	});

	it('does not stamp the window when no provider is configured', async () => {
		mockDoorKnockProvider.mockReturnValue({ ok: false, error: 'nope' });
		await POST(makeReq('?key=test-cron-secret') as never);
		expect(mockBeginRefresh).not.toHaveBeenCalled();
	});

	it('does not ping Slack on a clean run', async () => {
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(200);
		expect(mockPostMessage).not.toHaveBeenCalled();
	});

	// The provider decides what deserves a human's attention and writes the
	// message; this route only delivers it.
	it('posts each provider warning to the tracking channel verbatim', async () => {
		mockRunSnapshot.mockResolvedValueOnce({
			...OK_RESULT,
			warnings: ['drift: ZZ9ZZ9, YY8YY8', 'second thing'],
		});
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(200);
		expect(mockPostMessage).toHaveBeenCalledTimes(2);
		expect(mockPostMessage).toHaveBeenCalledWith({
			channel: 'C_TRACK',
			text: 'drift: ZZ9ZZ9, YY8YY8',
		});
		expect(mockPostMessage).toHaveBeenCalledWith({ channel: 'C_TRACK', text: 'second thing' });
	});

	it('a Slack failure does not fail the snapshot response', async () => {
		mockRunSnapshot.mockResolvedValueOnce({ ...OK_RESULT, warnings: ['drift: ZZ9ZZ9'] });
		mockPostMessage.mockRejectedValueOnce(new Error('slack down'));
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(200);
		expect((await res.json()).warnings).toEqual(['drift: ZZ9ZZ9']);
	});

	it('returns 500 with the error message when the snapshot throws', async () => {
		mockRunSnapshot.mockRejectedValueOnce(
			new Error('no conversation codes parsed from the canvas'),
		);
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'no conversation codes parsed from the canvas' });
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from './$types';

const mockRunPacketTracker = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/env.js', () => ({ INTERNAL_CRON_SECRET: 'secret' }));
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: async () => ({ slackTurfChannelId: 'C_TURF' }),
}));
vi.mock('$lib/server/slack.js', () => ({ slack: { chat: { postMessage: mockPostMessage } } }));
vi.mock('$lib/server/van/packet-tracker-live.js', () => ({
	runPacketTracker: mockRunPacketTracker,
}));

const { POST } = await import('./+server.js');

const call = (key = 'secret') =>
	POST({
		url: new URL(`http://localhost/api/internal/packet-tracker-sync?key=${key}`),
	} as unknown as RequestEvent);

const result = {
	filled: 2,
	updated: 0,
	failed: 0,
	walkInsFilled: 0,
	walkInsCleared: 0,
	deferred: 0,
	deferredFor: {},
	unrouted: 0,
	unroutedRegions: [] as string[],
	assignmentsChanged: 40,
	budgetLapsed: false,
	warnings: [] as string[],
};

beforeEach(() => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'log').mockImplementation(() => {});
	mockRunPacketTracker.mockReset().mockResolvedValue(result);
	mockPostMessage.mockReset().mockResolvedValue({});
});

describe('the Packet Tracker sync', () => {
	it('refuses a call without the key', async () => {
		expect((await call('wrong')).status).toBe(401);
		expect(mockRunPacketTracker).not.toHaveBeenCalled();
	});

	it('runs the tracker with the turf channel for its alerts, and says what it did', async () => {
		const res = await call();
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ filled: 2, assignmentsChanged: 40 });
		const [, options] = mockRunPacketTracker.mock.calls[0]!;
		expect(options.channelId).toBe('C_TURF');
		expect(options.timeBudgetMs).toBeLessThan(2 * 60 * 1000);
	});

	it('says skipped when the tracker did not run', async () => {
		mockRunPacketTracker.mockResolvedValue(null);
		expect(await (await call()).json()).toEqual({ skipped: true });
	});

	it('posts its advisory warnings to the turf channel', async () => {
		mockRunPacketTracker.mockResolvedValue({
			...result,
			warnings: ['[sheets] the Packet Tracker row for Turf 01 (Dana) was deleted in the sheet'],
		});
		await call();
		expect(mockPostMessage).toHaveBeenCalledOnce();
		expect(mockPostMessage.mock.calls[0]![0]).toMatchObject({ channel: 'C_TURF' });
		expect(mockPostMessage.mock.calls[0]![0].text).toContain('was deleted in the sheet');
	});

	// The tracker posts its own operator alert through postAlert, one message
	// per ongoing problem; repeating it here would say each failure twice.
	it('leaves failure alerts to the tracker', async () => {
		mockRunPacketTracker.mockResolvedValue({ ...result, failed: 3 });
		await call();
		expect(mockPostMessage).not.toHaveBeenCalled();
	});

	it('answers 500 when the tracker throws', async () => {
		mockRunPacketTracker.mockRejectedValue(new Error('libsql is gone'));
		const res = await call();
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'libsql is gone' });
	});
});

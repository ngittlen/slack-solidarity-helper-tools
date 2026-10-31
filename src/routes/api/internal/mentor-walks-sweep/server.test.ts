import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from './$types';

const mockQueueAlerts = vi.hoisted(() => vi.fn());
const mockDispatch = vi.hoisted(() => vi.fn());
const mockQueueReminders = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/env.js', () => ({
	INTERNAL_CRON_SECRET: 'secret',
	APP_URL: 'https://turf.example.org',
}));
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: async () => ({
		mentorWalksVisibility: 'everyone',
		chapterChannelMap: [],
		turfCustomChapters: [],
		slackTurfChannelId: '',
	}),
}));
vi.mock('$lib/server/mentor-walks/store.js', () => ({ purgeExpiredPhones: async () => 0 }));
vi.mock('$lib/server/mentor-walks/walk-events.js', () => ({
	queueReminders: mockQueueReminders,
	queueCheckins: async () => {},
}));
vi.mock('$lib/server/mentor-walks/alerts.js', () => ({ queueAlerts: mockQueueAlerts }));
vi.mock('$lib/server/mentor-walks/no-show.js', () => ({ postPendingNoShows: async () => {} }));
vi.mock('$lib/server/mentor-walks/notify.js', () => ({ dispatchPending: mockDispatch }));
vi.mock('$lib/server/mentor-walks/dispatch.js', () => ({
	LIVE_DISPATCH: {},
	liveNoShowDeps: () => ({}),
}));

const { POST } = await import('./+server.js');

const call = (key = 'secret') =>
	POST({
		url: new URL(`http://localhost/api/internal/mentor-walks-sweep?key=${key}`),
	} as unknown as RequestEvent);

beforeEach(() => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mockQueueAlerts.mockReset().mockResolvedValue(2);
	mockQueueReminders.mockReset().mockResolvedValue(undefined);
	mockDispatch.mockReset().mockResolvedValue({ sent: 1, skipped: 0, failed: 0 });
});

describe('the mentor walks sweep', () => {
	it('refuses a call without the key', async () => {
		expect((await call('wrong')).status).toBe(401);
		expect(mockDispatch).not.toHaveBeenCalled();
	});

	it('runs every step and sends what is queued', async () => {
		const res = await call();
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, alertsQueued: 2, sent: 1 });
	});

	it('still sends, and runs the other steps, when one step fails', async () => {
		mockQueueAlerts.mockRejectedValue(new Error('bad row'));
		const res = await call();
		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ ok: false, failedSteps: ['alerts'], sent: 1 });
		expect(mockQueueReminders).toHaveBeenCalled();
		expect(mockDispatch).toHaveBeenCalled();
	});
});

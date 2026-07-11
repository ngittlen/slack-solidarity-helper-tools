import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockRunSnapshot = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
	INTERNAL_CRON_SECRET: 'test-cron-secret',
	SLACK_BOT_TOKEN: 'xoxb-test',
	OPENFIELD_BASE_URL: 'https://campaign.openfield.ai',
	OPENFIELD_USERNAME: 'bot',
	OPENFIELD_PASSWORD: 'pw',
	DOOR_KNOCK_CHANNEL_ID: 'C_DOOR',
}));

vi.mock('$lib/server/door-knock-snapshot', () => ({
	runDoorKnockSnapshot: mockRunSnapshot,
	UNMAPPED_CHAPTER: 'Unmapped',
}));
vi.mock('$lib/server/slack', () => ({ slack: { chat: { postMessage: mockPostMessage } } }));
vi.mock('$lib/server/settings', () => ({ loadSettings: mockLoadSettings }));
vi.mock('$lib/server/door-knock-canvas', () => ({ fetchConversationCodesCanvas: vi.fn() }));
vi.mock('$lib/server/openfield', () => ({ createOpenfieldClient: vi.fn(() => ({})) }));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/env', () => ({
	get INTERNAL_CRON_SECRET() {
		return mockEnv.INTERNAL_CRON_SECRET;
	},
	get SLACK_BOT_TOKEN() {
		return mockEnv.SLACK_BOT_TOKEN;
	},
	get OPENFIELD_BASE_URL() {
		return mockEnv.OPENFIELD_BASE_URL;
	},
	get OPENFIELD_USERNAME() {
		return mockEnv.OPENFIELD_USERNAME;
	},
	get OPENFIELD_PASSWORD() {
		return mockEnv.OPENFIELD_PASSWORD;
	},
	get DOOR_KNOCK_CHANNEL_ID() {
		return mockEnv.DOOR_KNOCK_CHANNEL_ID;
	},
}));

function makeReq(query: string) {
	return { url: new URL(`http://localhost/api/internal/door-knock-snapshot${query}`) };
}

describe('POST /api/internal/door-knock-snapshot', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockEnv.OPENFIELD_BASE_URL = 'https://campaign.openfield.ai';
		mockEnv.DOOR_KNOCK_CHANNEL_ID = 'C_DOOR';
		mockRunSnapshot.mockResolvedValue({
			date: '2026-07-06',
			codesFound: 2,
			codesResolved: 2,
			codesFailed: [],
			unattributedCodes: [],
			offCanvasCodes: [],
			rowsWritten: 2,
			totalAttempts: 42,
		});
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

	it('returns 500 with a clear message when Openfield config is missing', async () => {
		mockEnv.OPENFIELD_BASE_URL = '';
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(500);
		expect((await res.json()).error).toMatch(/OPENFIELD/);
		expect(mockRunSnapshot).not.toHaveBeenCalled();
	});

	it('returns 500 when the channel id is missing', async () => {
		mockEnv.DOOR_KNOCK_CHANNEL_ID = '';
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(500);
		expect((await res.json()).error).toMatch(/DOOR_KNOCK_CHANNEL_ID/);
	});

	it('runs the snapshot and returns its result', async () => {
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ date: '2026-07-06', totalAttempts: 42 });
		expect(mockRunSnapshot).toHaveBeenCalledTimes(1);
	});

	it('does not ping Slack when every code was attributed', async () => {
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(200);
		expect(mockPostMessage).not.toHaveBeenCalled();
	});

	it('posts a layout-drift warning to the tracking channel for unattributed codes', async () => {
		mockRunSnapshot.mockResolvedValueOnce({
			date: '2026-07-06',
			codesFound: 10,
			codesResolved: 12,
			codesFailed: [],
			unattributedCodes: ['ZZ9ZZ9', 'YY8YY8'],
			offCanvasCodes: [],
			rowsWritten: 12,
			totalAttempts: 500,
		});
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(200);
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				channel: 'C_TRACK',
				text: expect.stringContaining('ZZ9ZZ9, YY8YY8'),
			}),
		);
	});

	it('posts a warning when removed-from-canvas codes still logged doors', async () => {
		mockRunSnapshot.mockResolvedValueOnce({
			date: '2026-07-06',
			codesFound: 10,
			codesResolved: 10,
			codesFailed: [],
			unattributedCodes: [],
			offCanvasCodes: ['OLD123'],
			rowsWritten: 11,
			totalAttempts: 500,
		});
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(200);
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({ text: expect.stringContaining('OLD123') }),
		);
	});

	it('a Slack failure does not fail the snapshot response', async () => {
		mockRunSnapshot.mockResolvedValueOnce({
			date: '2026-07-06',
			codesFound: 10,
			codesResolved: 11,
			codesFailed: [],
			unattributedCodes: ['ZZ9ZZ9'],
			offCanvasCodes: [],
			rowsWritten: 11,
			totalAttempts: 500,
		});
		mockPostMessage.mockRejectedValueOnce(new Error('slack down'));
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(200);
		expect((await res.json()).unattributedCodes).toEqual(['ZZ9ZZ9']);
	});

	it('returns 500 with the error message when the snapshot throws', async () => {
		mockRunSnapshot.mockRejectedValueOnce(new Error('no conversation codes parsed from the canvas'));
		const res = await POST(makeReq('?key=test-cron-secret') as never);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'no conversation codes parsed from the canvas' });
	});
});

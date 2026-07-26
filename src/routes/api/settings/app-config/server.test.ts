import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';
import {
	MAX_TICKER_COLUMNS_PER_SECOND,
	MIN_TICKER_COLUMNS_PER_SECOND,
} from '$lib/ticker-speed.js';

const mockSaveAppConfig = vi.hoisted(() => vi.fn());
const mockValidateChannel = vi.hoisted(() => vi.fn());
const mockGetSlackChannels = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({ slack: {} }));
vi.mock('$lib/server/settings', () => ({ saveAppConfig: mockSaveAppConfig }));
vi.mock('$lib/server/settings-validation', () => ({
	validateSlackChannel: mockValidateChannel,
}));
vi.mock('$lib/server/autocomplete-sources', () => ({
	getSlackChannels: mockGetSlackChannels,
}));

const authed = {
	locals: { session: { slackUserId: 'U123', slackUserName: 'Alice', isAdmin: true } },
};
const unauthed = { locals: { session: null } };
const nonAdmin = {
	locals: { session: { slackUserId: 'U999', slackUserName: 'Bob', isAdmin: false } },
};

function makeEvent(session: typeof authed | typeof unauthed | typeof nonAdmin, body: unknown) {
	return {
		...session,
		request: { json: async () => body } as Request,
	};
}

describe('POST /api/settings/app-config', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSaveAppConfig.mockResolvedValue(undefined);
		mockValidateChannel.mockResolvedValue({ ok: true, name: 'general' });
		mockGetSlackChannels.mockResolvedValue({
			items: [{ id: 'C_GEN', name: 'general', isPrivate: false }],
			fetchedAt: 0,
		});
	});

	it('returns 401 when not authenticated', async () => {
		const res = await POST(
			makeEvent(unauthed, { slackTrackingChannelId: 'C1' }) as never,
		);
		expect(res.status).toBe(401);
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('returns 403 when not admin', async () => {
		const res = await POST(makeEvent(nonAdmin, { slackTrackingChannelId: 'C1' }) as never);
		expect(res.status).toBe(403);
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('returns 400 when no recognized field is present', async () => {
		const res = await POST(makeEvent(authed, { somethingElse: 1 }) as never);
		expect(res.status).toBe(400);
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('saves a validated channel patch', async () => {
		const res = await POST(makeEvent(authed, { slackTrackingChannelId: 'C1' }) as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(mockValidateChannel).toHaveBeenCalledWith(expect.anything(), 'C1');
		expect(mockSaveAppConfig).toHaveBeenCalledWith(
			expect.anything(),
			{ slackTrackingChannelId: 'C1' },
			{ id: 'U123', name: 'Alice' },
		);
	});

	it('saves both channels in one patch, validating each', async () => {
		const res = await POST(
			makeEvent(authed, {
				slackTrackingChannelId: 'C1',
				slackGrowthReportChannelId: 'C2',
			}) as never,
		);
		expect(res.status).toBe(200);
		expect(mockValidateChannel).toHaveBeenCalledTimes(2);
		expect(mockSaveAppConfig).toHaveBeenCalledWith(
			expect.anything(),
			{ slackTrackingChannelId: 'C1', slackGrowthReportChannelId: 'C2' },
			expect.anything(),
		);
	});

	it('400 for an unknown channel id; 503 when the list is transiently down', async () => {
		mockValidateChannel.mockResolvedValue({ ok: false, error: 'nope', transient: false });
		let res = await POST(makeEvent(authed, { slackGrowthReportChannelId: 'C_BAD' }) as never);
		expect(res.status).toBe(400);

		mockValidateChannel.mockResolvedValue({ ok: false, error: 'down', transient: true });
		res = await POST(makeEvent(authed, { slackGrowthReportChannelId: 'C1' }) as never);
		expect(res.status).toBe(503);
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('400 for a blank or non-string channel id', async () => {
		for (const bad of ['', '   ', 7]) {
			const res = await POST(makeEvent(authed, { slackTrackingChannelId: bad }) as never);
			expect(res.status).toBe(400);
		}
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('saves an alpha in [0, 1] inclusive, including the endpoints', async () => {
		for (const alpha of [0, 0.5, 1]) {
			const res = await POST(
				makeEvent(authed, { slackGrowthReportRankingAlpha: alpha }) as never,
			);
			expect(res.status).toBe(200);
		}
		expect(mockSaveAppConfig).toHaveBeenCalledTimes(3);
		expect(mockSaveAppConfig).toHaveBeenLastCalledWith(
			expect.anything(),
			{ slackGrowthReportRankingAlpha: 1 },
			expect.anything(),
		);
	});

	it('400 for an out-of-range or non-numeric alpha', async () => {
		for (const bad of [-0.1, 1.1, NaN, Infinity, '0.5']) {
			const res = await POST(
				makeEvent(authed, { slackGrowthReportRankingAlpha: bad }) as never,
			);
			expect(res.status).toBe(400);
		}
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('saves a ticker speed inside the supported range, endpoints included', async () => {
		for (const rate of [MIN_TICKER_COLUMNS_PER_SECOND, 20, MAX_TICKER_COLUMNS_PER_SECOND]) {
			const res = await POST(makeEvent(authed, { doorTickerColumnsPerSecond: rate }) as never);
			expect(res.status).toBe(200);
		}
		expect(mockSaveAppConfig).toHaveBeenLastCalledWith(
			expect.anything(),
			{ doorTickerColumnsPerSecond: MAX_TICKER_COLUMNS_PER_SECOND },
			expect.anything(),
		);
	});

	// Above the maximum a step lasts under a frame and the stepped animation
	// turns back into the stutter it exists to avoid, so the bound is enforced
	// rather than merely suggested in the UI.
	it('400 for an out-of-range or non-numeric ticker speed', async () => {
		const bad = [
			MIN_TICKER_COLUMNS_PER_SECOND - 1,
			MAX_TICKER_COLUMNS_PER_SECOND + 1,
			0,
			-5,
			NaN,
			Infinity,
			'30',
		];
		for (const rate of bad) {
			const res = await POST(makeEvent(authed, { doorTickerColumnsPerSecond: rate }) as never);
			expect(res.status).toBe(400);
		}
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('saves a trimmed countdown label', async () => {
		const res = await POST(makeEvent(authed, { countdownLabel: '  Petition deadline  ' }) as never);
		expect(res.status).toBe(200);
		expect(mockSaveAppConfig).toHaveBeenCalledWith(
			expect.anything(),
			{ countdownLabel: 'Petition deadline' },
			expect.anything(),
		);
	});

	it('accepts an empty countdown label (no label shown)', async () => {
		const res = await POST(makeEvent(authed, { countdownLabel: '' }) as never);
		expect(res.status).toBe(200);
		expect(mockSaveAppConfig).toHaveBeenCalledWith(
			expect.anything(),
			{ countdownLabel: '' },
			expect.anything(),
		);
	});

	it('400 for a non-string or over-long countdown label', async () => {
		for (const bad of [7, 'x'.repeat(81)]) {
			const res = await POST(makeEvent(authed, { countdownLabel: bad }) as never);
			expect(res.status).toBe(400);
		}
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('normalizes countdownEndAt to canonical ISO', async () => {
		const res = await POST(
			makeEvent(authed, { countdownEndAt: '2026-08-15T12:00:00Z' }) as never,
		);
		expect(res.status).toBe(200);
		expect(mockSaveAppConfig).toHaveBeenCalledWith(
			expect.anything(),
			{ countdownEndAt: '2026-08-15T12:00:00.000Z' },
			expect.anything(),
		);
	});

	it('accepts an empty countdownEndAt as "clear the countdown"', async () => {
		const res = await POST(makeEvent(authed, { countdownEndAt: '' }) as never);
		expect(res.status).toBe(200);
		expect(mockSaveAppConfig).toHaveBeenCalledWith(
			expect.anything(),
			{ countdownEndAt: '' },
			expect.anything(),
		);
	});

	it('400 for a non-string or unparseable countdownEndAt', async () => {
		for (const bad of [7, 'not-a-date']) {
			const res = await POST(makeEvent(authed, { countdownEndAt: bad }) as never);
			expect(res.status).toBe(400);
		}
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('saves a trimmed welcome DM message whose #channels all resolve', async () => {
		const res = await POST(
			makeEvent(authed, { welcomeDmMessage: '  Welcome to {{channels}} and #general  ' }) as never,
		);
		expect(res.status).toBe(200);
		expect(mockSaveAppConfig).toHaveBeenCalledWith(
			expect.anything(),
			{ welcomeDmMessage: 'Welcome to {{channels}} and #general' },
			expect.anything(),
		);
	});

	it('accepts an empty welcome DM message (use the default) without a channel lookup', async () => {
		const res = await POST(makeEvent(authed, { welcomeDmMessage: '' }) as never);
		expect(res.status).toBe(200);
		expect(mockGetSlackChannels).not.toHaveBeenCalled();
		expect(mockSaveAppConfig).toHaveBeenCalledWith(
			expect.anything(),
			{ welcomeDmMessage: '' },
			expect.anything(),
		);
	});

	it('400 when the welcome DM references an unknown #channel', async () => {
		const res = await POST(
			makeEvent(authed, { welcomeDmMessage: 'Join #general and #nope' }) as never,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Unknown channel(s): #nope' });
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('503 when the channel list is down and the message has #channels', async () => {
		mockGetSlackChannels.mockRejectedValue(new Error('cache cold'));
		const res = await POST(makeEvent(authed, { welcomeDmMessage: 'See #general' }) as never);
		expect(res.status).toBe(503);
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('400 for a non-string or over-long welcome DM message', async () => {
		for (const bad of [7, 'x'.repeat(3001)]) {
			const res = await POST(makeEvent(authed, { welcomeDmMessage: bad }) as never);
			expect(res.status).toBe(400);
		}
		expect(mockSaveAppConfig).not.toHaveBeenCalled();
	});

	it('returns 400 for a non-JSON body', async () => {
		const event = {
			...authed,
			request: {
				json: async () => {
					throw new SyntaxError('bad');
				},
			} as unknown as Request,
		};
		const res = await POST(event as never);
		expect(res.status).toBe(400);
	});
});

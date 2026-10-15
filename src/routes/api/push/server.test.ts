import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnable = vi.hoisted(() => vi.fn());
const mockClaim = vi.hoisted(() => vi.fn());
const mockDisable = vi.hoisted(() => vi.fn());
const mockPublicKey = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/push.js', async (importOriginal) => ({
	parseSubscription: (await importOriginal<typeof import('$lib/server/push.js')>())
		.parseSubscription,
	enablePushDevice: mockEnable,
	claimPushDevice: mockClaim,
	disablePushDevice: mockDisable,
	pushPublicKey: mockPublicKey,
}));
vi.mock('$lib/server/env.js', () => ({
	APP_URL: 'https://app.example',
	VAPID_PUBLIC_KEY: '',
	VAPID_PRIVATE_KEY: '',
}));

import { DELETE, GET, POST } from './+server.js';

const SLACK = { slackUserId: 'U1', slackUserName: 'Dana', isAdmin: false };
const GOOGLE = { ...SLACK, slackUserId: 'google:7', authProvider: 'google' };
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'k', auth: 'a' } };

const event = (session: unknown, body?: unknown) =>
	({ locals: { session }, request: { json: async () => body } as Request }) as never;

beforeEach(() => {
	vi.clearAllMocks();
	mockPublicKey.mockReturnValue('PUBLIC');
	mockClaim.mockResolvedValue({ enabled: true, recipient: 'R1' });
	mockEnable.mockResolvedValue({ recipient: 'R1' });
	mockDisable.mockResolvedValue({ othersEnabled: false });
});

describe('/api/push', () => {
	it('answers nobody signed out', async () => {
		expect((await GET(event(null))).status).toBe(401);
		expect((await POST(event(null, { action: 'on', subscription: SUB }))).status).toBe(401);
		expect((await DELETE(event(null, { endpoint: SUB.endpoint }))).status).toBe(401);
		expect(mockEnable).not.toHaveBeenCalled();
	});

	it('gives the key, and whether push stands in for Slack', async () => {
		expect(await (await GET(event(SLACK))).json()).toEqual({ publicKey: 'PUBLIC', viaSlack: true });
		expect(await (await GET(event(GOOGLE))).json()).toEqual({
			publicKey: 'PUBLIC',
			viaSlack: false,
		});
	});

	it('turns notifications on for the caller, under their own id', async () => {
		const res = await POST(event(GOOGLE, { action: 'on', subscription: SUB }));
		expect(await res.json()).toEqual({ recipient: 'R1' });
		expect(mockEnable).toHaveBeenCalledWith({}, 'google:7', SUB);
	});

	it('claims the browser for the caller and says whether they have it on', async () => {
		const res = await POST(event(SLACK, { action: 'claim', subscription: SUB }));
		expect(await res.json()).toEqual({ enabled: true, recipient: 'R1' });
		expect(mockClaim).toHaveBeenCalledWith({}, 'U1', SUB);
		expect(mockEnable).not.toHaveBeenCalled();
	});

	it('refuses an unknown action', async () => {
		expect((await POST(event(SLACK, { subscription: SUB }))).status).toBe(400);
		expect((await POST(event(SLACK, { action: 'x', subscription: SUB }))).status).toBe(400);
		expect(mockEnable).not.toHaveBeenCalled();
		expect(mockClaim).not.toHaveBeenCalled();
	});

	it('refuses a malformed subscription', async () => {
		const res = await POST(
			event(SLACK, { action: 'on', subscription: { ...SUB, endpoint: 'http://x' } }),
		);
		expect(res.status).toBe(400);
		expect(mockEnable).not.toHaveBeenCalled();
	});

	// The server POSTs to every saved endpoint: only push services may be one.
	it('refuses an endpoint that is not a push service', async () => {
		const endpoint = 'https://internal.example/hook';
		const res = await POST(event(SLACK, { action: 'on', subscription: { ...SUB, endpoint } }));
		expect(res.status).toBe(400);
		expect(mockEnable).not.toHaveBeenCalled();
	});

	it('refuses to subscribe when push is not set up', async () => {
		mockPublicKey.mockReturnValue(null);
		expect((await POST(event(SLACK, { action: 'on', subscription: SUB }))).status).toBe(503);
	});

	it("turns off only the caller's setting, and says whether anyone else wants it", async () => {
		mockDisable.mockResolvedValue({ othersEnabled: true });
		const res = await DELETE(event(SLACK, { endpoint: SUB.endpoint }));
		expect(await res.json()).toEqual({ othersEnabled: true });
		expect(mockDisable).toHaveBeenCalledWith({}, 'U1', SUB.endpoint);
	});
});

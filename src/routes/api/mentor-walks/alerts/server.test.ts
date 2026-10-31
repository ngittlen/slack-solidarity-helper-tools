import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from './$types';

const mockLoadAlertsView = vi.hoisted(() => vi.fn());
const mockSave = vi.hoisted(() => vi.fn());
const mockStop = vi.hoisted(() => vi.fn());
const mockAnswer = vi.hoisted(() => vi.fn());
const blocked = vi.hoisted(() => new Set<string>());

vi.mock('$lib/server/db.js', () => ({ db: {} }));
vi.mock('$lib/server/env.js', () => ({ SLACK_SUPERUSER_ID: 'U_SUPER' }));
vi.mock('$lib/server/settings.js', () => ({
	loadSettings: async () => ({ mentorWalksVisibility: 'everyone', volunteerGuidelinesUrl: '' }),
	loadVanBlockedIds: async () => blocked,
}));
vi.mock('$lib/server/mentor-walks/panel.js', () => ({
	loadAlertsView: mockLoadAlertsView,
	saveAlertsAction: mockSave,
	stopAlertsAction: mockStop,
	answerFinderPrompt: mockAnswer,
}));

const { GET, PUT, DELETE } = await import('./+server.js');

const KIM = { slackUserId: 'U_KIM', slackUserName: 'Kim', isAdmin: false };

function event(session: unknown, body?: unknown): RequestEvent {
	const request = new Request('http://localhost/api/mentor-walks/alerts', {
		method: body === undefined ? 'GET' : 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { locals: { session }, request } as unknown as RequestEvent;
}

beforeEach(() => {
	blocked.clear();
	mockLoadAlertsView.mockReset();
	mockSave.mockReset().mockResolvedValue({ ok: true, value: true });
	mockStop.mockReset().mockResolvedValue({ ok: true, value: true });
	mockAnswer.mockReset().mockResolvedValue({ ok: true, value: 'yes' });
});

describe('/api/mentor-walks/alerts', () => {
	it('refuses anyone signed out', async () => {
		expect((await GET(event(null))).status).toBe(401);
		expect((await PUT(event(null, { zip: '48104', radius: 10 }))).status).toBe(401);
		expect((await DELETE(event(null))).status).toBe(401);
	});

	it('reads the alerts, or says they aren’t available', async () => {
		mockLoadAlertsView.mockResolvedValueOnce({ alerts: { zip: '48104', radius: 10 } });
		expect(await (await GET(event(KIM))).json()).toEqual({
			alerts: { zip: '48104', radius: 10 },
			available: true,
		});
		mockLoadAlertsView.mockResolvedValueOnce(null);
		expect(await (await GET(event(KIM))).json()).toEqual({ alerts: null, available: false });
	});

	it('tells the panel a blocked person is blocked', async () => {
		blocked.add('U_KIM');
		mockLoadAlertsView.mockResolvedValueOnce(null);
		await GET(event(KIM));
		expect(mockLoadAlertsView).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ blocked: true }),
		);
	});

	it('saves them, and passes on why it couldn’t', async () => {
		const res = await PUT(event(KIM, { zip: '48104', radius: 25 }));
		expect(res.status).toBe(200);
		expect(mockSave).toHaveBeenCalledWith(expect.anything(), expect.anything(), '48104', '25');
		expect(mockAnswer).not.toHaveBeenCalled();

		mockSave.mockResolvedValueOnce({ ok: false, status: 400, message: 'No such ZIP' });
		const bad = await PUT(event(KIM, { zip: '00000', radius: 10 }));
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: 'No such ZIP' });
	});

	it('answers the new-person prompt Yes when saved from it', async () => {
		await PUT(event(KIM, { zip: '48104', radius: 10, fromPrompt: true }));
		expect(mockAnswer).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'yes');

		mockAnswer.mockClear();
		mockSave.mockResolvedValueOnce({ ok: false, status: 400, message: 'No such ZIP' });
		await PUT(event(KIM, { zip: '00000', radius: 10, fromPrompt: true }));
		expect(mockAnswer).not.toHaveBeenCalled();
	});

	it('refuses a malformed body and someone without a name yet', async () => {
		const request = new Request('http://localhost/api/mentor-walks/alerts', {
			method: 'PUT',
			body: 'not json',
		});
		const res = await PUT({ locals: { session: KIM }, request } as unknown as RequestEvent);
		expect(res.status).toBe(400);
		expect((await PUT(event({ ...KIM, needsName: true }, { zip: '48104' }))).status).toBe(403);
		expect(await (await GET(event({ ...KIM, needsName: true }))).json()).toEqual({
			alerts: null,
			available: false,
		});
	});

	it('stops them', async () => {
		expect((await DELETE(event(KIM))).status).toBe(200);
		expect(mockStop).toHaveBeenCalled();
	});
});

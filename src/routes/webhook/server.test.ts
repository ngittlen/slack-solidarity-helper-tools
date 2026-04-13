import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './+server.js';

// vi.mock factories are hoisted — use vi.hoisted() so the fn refs are ready.
const mockExecute = vi.hoisted(() => vi.fn());
const mockPostMessage = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: { execute: mockExecute } }));
vi.mock('$lib/server/slack', () => ({ slack: { chat: { postMessage: mockPostMessage } } }));
vi.mock('$lib/server/env', () => ({
	WEBHOOK_SECRET: 'secret123',
	SLACK_TRACKING_CHANNEL_ID: 'C_TEST',
	APP_URL: 'http://localhost',
}));
vi.mock('$lib/server/events', () => ({ notifyNewRequest: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

// --- Helpers ---

function makeEvent(params: Record<string, string>) {
	const url = new URL('http://localhost/webhook');
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return { url };
}

// --- Tests ---

describe('GET /webhook', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// First call is the SELECT (check for existing), second is the INSERT.
		mockExecute
			.mockResolvedValueOnce({ rows: [] })
			.mockResolvedValue({ lastInsertRowid: 1n });
		mockPostMessage.mockResolvedValue({ ok: true });
	});

	it('returns 401 when secret is wrong', async () => {
		const res = await GET(makeEvent({ secret: 'wrong' }) as never);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'Unauthorized' });
		expect(mockExecute).not.toHaveBeenCalled();
	});

	it('returns 401 when secret is missing', async () => {
		const res = await GET(makeEvent({}) as never);
		expect(res.status).toBe(401);
	});

	it('returns 400 when neither email nor phone is provided', async () => {
		const res = await GET(makeEvent({ secret: 'secret123' }) as never);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'At least one of email or phone is required' });
	});

	it('returns 400 for invalid email (no @)', async () => {
		const res = await GET(makeEvent({ secret: 'secret123', email: 'notanemail' }) as never);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Invalid email address' });
	});

	it('accepts phone-only request (no email)', async () => {
		const res = await GET(makeEvent({ secret: 'secret123', phone: '555-1234' }) as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, email: null, phone: '555-1234' });
	});

	it('persists the record before posting to Slack', async () => {
		const order: string[] = [];
		mockExecute.mockReset();
		mockExecute
			.mockResolvedValueOnce({ rows: [] }) // SELECT — no existing record
			.mockImplementation(async () => { order.push('db'); return { lastInsertRowid: 1n }; }); // INSERT
		mockPostMessage.mockImplementation(async () => { order.push('slack'); return { ok: true }; });

		await GET(makeEvent({ secret: 'secret123', email: 'a@b.com' }) as never);
		expect(order).toEqual(['db', 'slack']);
	});

	it('trims whitespace from email, name, and phone', async () => {
		const res = await GET(
			makeEvent({ secret: 'secret123', email: '  a@b.com  ', name: ' Alice ', phone: ' 555 ' }) as never,
		);
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.email).toBe('a@b.com');
		expect(json.phone).toBe('555');
	});

	it('returns 502 when Slack API throws but DB write already happened', async () => {
		mockPostMessage.mockRejectedValue(new Error('Slack down'));
		const res = await GET(makeEvent({ secret: 'secret123', email: 'a@b.com' }) as never);
		expect(res.status).toBe(502);
		expect(mockExecute).toHaveBeenCalledTimes(2); // SELECT then INSERT
	});

	it('passes correct args to db.execute for the INSERT', async () => {
		await GET(makeEvent({ secret: 'secret123', email: 'a@b.com', name: 'Alice' }) as never);
		// args: [email, name, phone, timestamp] — 'Alice' only appears in the INSERT, not the SELECT
		expect(mockExecute).toHaveBeenCalledWith(
			expect.objectContaining({
				args: expect.arrayContaining(['a@b.com', 'Alice', null]),
			}),
		);
	});
});
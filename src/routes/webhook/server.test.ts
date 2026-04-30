import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './+server.js';

const mockSelectLimit = vi.hoisted(() => vi.fn());
const mockSelectWhere = vi.hoisted(() => vi.fn());
const mockSelectFrom = vi.hoisted(() => vi.fn());
const mockSelect = vi.hoisted(() => vi.fn());

const mockUpdateWhere = vi.hoisted(() => vi.fn());
const mockUpdateSet = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());

const mockInsertReturning = vi.hoisted(() => vi.fn());
const mockInsertValues = vi.hoisted(() => vi.fn());
const mockInsert = vi.hoisted(() => vi.fn());

const mockPostMessage = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({
	db: { select: mockSelect, update: mockUpdate, insert: mockInsert },
}));
vi.mock('$lib/server/slack', () => ({ slack: { chat: { postMessage: mockPostMessage } } }));
vi.mock('$lib/server/env', () => ({
	WEBHOOK_SECRET: 'secret123',
	SLACK_TRACKING_CHANNEL_ID: 'C_TEST',
	APP_URL: 'http://localhost',
}));
vi.mock('$lib/server/events', () => ({ notifyNewRequest: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

function makeEvent(params: Record<string, string>) {
	const url = new URL('http://localhost/webhook');
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return { url };
}

describe('GET /webhook', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		mockSelect.mockReturnValue({ from: mockSelectFrom });
		mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
		mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
		mockSelectLimit.mockResolvedValue([]);

		mockUpdate.mockReturnValue({ set: mockUpdateSet });
		mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
		mockUpdateWhere.mockResolvedValue(undefined);

		mockInsert.mockReturnValue({ values: mockInsertValues });
		mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
		mockInsertReturning.mockResolvedValue([{ id: 1 }]);

		mockPostMessage.mockResolvedValue({ ok: true });
	});

	it('returns 401 when secret is wrong', async () => {
		const res = await GET(makeEvent({ secret: 'wrong' }) as never);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'Unauthorized' });
		expect(mockSelect).not.toHaveBeenCalled();
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
		mockInsertReturning.mockImplementation(async () => {
			order.push('db');
			return [{ id: 1 }];
		});
		mockPostMessage.mockImplementation(async () => {
			order.push('slack');
			return { ok: true };
		});

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
		expect(mockSelect).toHaveBeenCalledTimes(1);
		expect(mockInsert).toHaveBeenCalledTimes(1);
	});

	it('passes correct args to the INSERT', async () => {
		await GET(makeEvent({ secret: 'secret123', email: 'a@b.com', name: 'Alice' }) as never);
		expect(mockInsertValues).toHaveBeenCalledWith(
			expect.objectContaining({ email: 'a@b.com', name: 'Alice', phone: null }),
		);
	});

	it('updates the existing row instead of inserting when a match is found', async () => {
		mockSelectLimit.mockResolvedValueOnce([{ id: 7 }]);
		const res = await GET(
			makeEvent({ secret: 'secret123', email: 'a@b.com', name: 'Alice', phone: '555' }) as never,
		);
		expect(res.status).toBe(200);
		expect(mockInsert).not.toHaveBeenCalled();
		expect(mockUpdate).toHaveBeenCalledTimes(1);
		expect(mockUpdateSet).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Alice', requestedAt: expect.any(String) }),
		);
		// Dedup path skips Slack post — only new requests notify the channel
		expect(mockPostMessage).not.toHaveBeenCalled();
	});

	it('preserves the existing name when a duplicate webhook arrives without one', async () => {
		mockSelectLimit.mockResolvedValueOnce([{ id: 7 }]);
		await GET(makeEvent({ secret: 'secret123', email: 'a@b.com' }) as never);
		expect(mockUpdateSet).toHaveBeenCalledTimes(1);
		const setArg = mockUpdateSet.mock.calls[0]![0];
		expect(setArg).not.toHaveProperty('name');
		expect(setArg).toHaveProperty('requestedAt');
	});

	it('prefers the email match when both email and phone match different rows', async () => {
		// Email lookup hits row 7 — phone fallback should be skipped entirely.
		// (We don't queue a phone result; if the code regressed and ran the
		// phone query, the default [] would make it INSERT, which the
		// assertions below would catch.)
		mockSelectLimit.mockResolvedValueOnce([{ id: 7 }]);

		await GET(
			makeEvent({ secret: 'secret123', email: 'a@b.com', phone: '555' }) as never,
		);

		expect(mockSelect).toHaveBeenCalledTimes(1);
		expect(mockUpdate).toHaveBeenCalledTimes(1);
		expect(mockInsert).not.toHaveBeenCalled();
	});

	it('falls back to phone match when email does not match an existing row', async () => {
		mockSelectLimit
			.mockResolvedValueOnce([])           // email: no match
			.mockResolvedValueOnce([{ id: 99 }]); // phone: match

		await GET(
			makeEvent({ secret: 'secret123', email: 'new@b.com', phone: '555' }) as never,
		);

		expect(mockSelect).toHaveBeenCalledTimes(2);
		expect(mockUpdate).toHaveBeenCalledTimes(1);
		expect(mockInsert).not.toHaveBeenCalled();
	});

	it('inserts when neither email nor phone matches', async () => {
		mockSelectLimit.mockResolvedValue([]);

		await GET(
			makeEvent({ secret: 'secret123', email: 'new@b.com', phone: '555' }) as never,
		);

		expect(mockSelect).toHaveBeenCalledTimes(2);
		expect(mockInsert).toHaveBeenCalledTimes(1);
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it('skips the email lookup entirely for a phone-only request', async () => {
		mockSelectLimit.mockResolvedValueOnce([{ id: 99 }]);

		await GET(makeEvent({ secret: 'secret123', phone: '555' }) as never);

		expect(mockSelect).toHaveBeenCalledTimes(1);
		expect(mockUpdate).toHaveBeenCalledTimes(1);
	});
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findUserByEmailStrict, setUserCustomProperty } from './solidarity.js';

function rateLimited(retryAfter = '0') {
	return {
		ok: false,
		status: 429,
		headers: new Headers({ 'Retry-After': retryAfter }),
		json: async () => ({}),
		text: async () => 'rate limited',
	} as unknown as Response;
}

function found(id: number) {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => ({ data: [{ id, chapter_id: null, chapter_ids: [], address: null }] }),
	} as unknown as Response;
}

function updated() {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		text: async () => '',
	} as unknown as Response;
}

describe('findUserByEmailStrict', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('retries on 429 honoring Retry-After, then returns the match', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock.mockResolvedValueOnce(rateLimited('0')).mockResolvedValueOnce(found(42));

		const user = await findUserByEmailStrict('token', 'a@example.org');

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(user?.id).toBe(42);
	});

	it('throws once the retry budget is exhausted (6 consecutive 429s)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'));

		await expect(findUserByEmailStrict('token', 'a@example.org')).rejects.toThrow(
			/retry budget exhausted/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it('keeps retry budgets independent across concurrent lookups', async () => {
		// Mirrors coalition-reconcile.ts's mapPool: several lookups in flight at
		// once, each with its own fetchWithRetry budget. One retries once and
		// succeeds, one exhausts its own budget and throws, one never retries —
		// none of that should be visible to (or borrowed from) the others.
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const callCounts = new Map<string, number>();
		fetchMock.mockImplementation(async (url) => {
			const email = new URL(url as string).searchParams.get('email') ?? '';
			const n = (callCounts.get(email) ?? 0) + 1;
			callCounts.set(email, n);
			if (email === 'retries-once@example.org') return n === 1 ? rateLimited('0') : found(1);
			if (email === 'exhausts@example.org') return rateLimited('0');
			if (email === 'clean@example.org') return found(3);
			throw new Error(`unexpected email in test: ${email}`);
		});

		const [retriesOnce, exhausts, clean] = await Promise.allSettled([
			findUserByEmailStrict('token', 'retries-once@example.org'),
			findUserByEmailStrict('token', 'exhausts@example.org'),
			findUserByEmailStrict('token', 'clean@example.org'),
		]);

		expect(retriesOnce.status).toBe('fulfilled');
		expect(retriesOnce.status === 'fulfilled' && retriesOnce.value?.id).toBe(1);
		expect(exhausts.status).toBe('rejected');
		expect(exhausts.status === 'rejected' && exhausts.reason.message).toMatch(
			/retry budget exhausted/,
		);
		expect(clean.status).toBe('fulfilled');
		expect(clean.status === 'fulfilled' && clean.value?.id).toBe(3);

		// One retry (2 calls), a full exhausted budget (6 calls), and a clean
		// single call (1 call) — each count only reflects its own lookup.
		expect(callCounts.get('retries-once@example.org')).toBe(2);
		expect(callCounts.get('exhausts@example.org')).toBe(6);
		expect(callCounts.get('clean@example.org')).toBe(1);
	});
});

describe('setUserCustomProperty', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('retries on 429 honoring Retry-After, then succeeds', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock.mockResolvedValueOnce(rateLimited('0')).mockResolvedValueOnce(updated());

		await expect(
			setUserCustomProperty('token', 42, 'in_coalition_x', 'true'),
		).resolves.toBeUndefined();

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('throws once the retry budget is exhausted (6 consecutive 429s)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		fetchMock
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'));

		await expect(setUserCustomProperty('token', 42, 'in_coalition_x', 'true')).rejects.toThrow(
			/retry budget exhausted/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});
});

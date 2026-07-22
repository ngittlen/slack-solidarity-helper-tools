import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchPaginated, fetchWithRetry } from './solidarity-paginate.js';

function rateLimited(retryAfter = '0') {
	return {
		ok: false,
		status: 429,
		headers: new Headers({ 'Retry-After': retryAfter }),
		json: async () => ({}),
		text: async () => 'rate limited',
	} as unknown as Response;
}

function statusResponse(status: number, ok: boolean) {
	return {
		ok,
		status,
		headers: new Headers(),
		json: async () => ({ data: [] }),
		text: async () => 'body',
	} as unknown as Response;
}

describe('fetchWithRetry', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns a non-429 success response without retrying', async () => {
		fetchMock.mockResolvedValueOnce(statusResponse(200, true));

		const res = await fetchWithRetry('https://example.test', {}, 'thing', 'tag', {
			retriesUsed: 0,
		});

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('returns a non-429 error response as-is — callers check res.ok themselves', async () => {
		fetchMock.mockResolvedValueOnce(statusResponse(500, false));

		const res = await fetchWithRetry('https://example.test', {}, 'thing', 'tag', {
			retriesUsed: 0,
		});

		expect(res.status).toBe(500);
		expect(res.ok).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('fetchPaginated', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function page(items: unknown[]) {
		return {
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({ data: items }),
		} as unknown as Response;
	}

	it('carries the retry budget across pages instead of resetting it per page (FR-004a)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));

		fetchMock
			// page 0: three 429s, then a full page — spends 3 of the 5-retry budget.
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(page(fullPage))
			// page 1: only 2 retries remain in the shared budget, so the third
			// 429 here exhausts it — even though page 1 alone has only seen 3.
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'))
			.mockResolvedValueOnce(rateLimited('0'));

		await expect(fetchPaginated('token', '/v1/users', '/v1/users')).rejects.toThrow(
			/retry budget exhausted/,
		);

		// 4 calls for page 0 + 3 for page 1 = 7. A budget reset per page (the
		// FR-004a bug this guards against) would instead take 4 + 6 = 10.
		expect(fetchMock).toHaveBeenCalledTimes(7);
	});
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVanClient, VanError, VAN_BASE_URL } from './client.js';

// VAN is modelled just far enough to prove the client drives the real
// protocol: Basic auth with the piped mode suffix, {items, nextPageLink}
// pagination, the {errors:[...]} envelope, and retry on 429/5xx.

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers(headers),
		text: async () => text,
		json: async () => JSON.parse(text),
	} as unknown as Response;
}

const config = { appName: 'campaign-app', apiKey: 'key-guid', databaseMode: 0 as const };

describe('createVanClient', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** Retries sleep on real timers, so tests that exercise them run the
	 *  promise and drain the fake clock alongside it. */
	async function withTimers<T>(promise: Promise<T>): Promise<T> {
		const settled = promise.then(
			(v) => ({ ok: true as const, v }),
			(e) => ({ ok: false as const, e }),
		);
		await vi.runAllTimersAsync();
		const result = await settled;
		if (!result.ok) throw result.e;
		return result.v;
	}

	it('authenticates with appName as username and apiKey|mode as password', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(200, { items: [] }));
		await createVanClient(config, fetchFn as never).folders();

		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe(`${VAN_BASE_URL}/folders`);
		const auth = (init.headers as Record<string, string>).Authorization;
		const decoded = Buffer.from(auth.replace('Basic ', ''), 'base64').toString();
		expect(decoded).toBe('campaign-app:key-guid|0');
	});

	it('sends mode 1 for My Campaign', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(200, { items: [] }));
		await createVanClient({ ...config, databaseMode: 1 }, fetchFn as never).folders();
		const auth = (fetchFn.mock.calls[0]![1].headers as Record<string, string>).Authorization;
		expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe(
			'campaign-app:key-guid|1',
		);
	});

	it('follows nextPageLink across pages and concatenates items', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(
				res(200, {
					items: [{ folderId: 1, name: 'A' }],
					nextPageLink: `${VAN_BASE_URL}/folders?$skip=1`,
				}),
			)
			.mockResolvedValueOnce(res(200, { items: [{ folderId: 2, name: 'B' }], nextPageLink: null }));

		const folders = await createVanClient(config, fetchFn as never).folders();
		expect(folders.map((f) => f.folderId)).toEqual([1, 2]);
		expect(fetchFn.mock.calls[1]![0]).toBe(`${VAN_BASE_URL}/folders?$skip=1`);
	});

	it('stops rather than looping when nextPageLink points at itself', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(
				res(200, { items: [{ folderId: 1, name: 'A' }], nextPageLink: `${VAN_BASE_URL}/folders` }),
			);
		const folders = await createVanClient(config, fetchFn as never).folders();
		expect(folders).toHaveLength(1);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('parses the {errors:[...]} envelope into VanError codes and message', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(
				res(403, { errors: [{ code: 'INSUFFICIENT_TIER', text: 'Not authorized' }] }),
			);
		const err = await createVanClient(config, fetchFn as never)
			.savedLists()
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(VanError);
		expect((err as VanError).status).toBe(403);
		expect((err as VanError).codes).toEqual(['INSUFFICIENT_TIER']);
		expect((err as VanError).isAuthFailure).toBe(true);
		expect((err as VanError).message).toContain('Not authorized');
	});

	it('does not retry a 403 — a missing tier will not fix itself', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(403, { errors: [{ code: 'X', text: 'nope' }] }));
		await expect(createVanClient(config, fetchFn as never).folders()).rejects.toThrow(VanError);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('retries a 429 and succeeds', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(res(429, '', { 'Retry-After': '1' }))
			.mockResolvedValueOnce(res(200, { items: [{ folderId: 7, name: 'G' }] }));

		const folders = await withTimers(createVanClient(config, fetchFn as never).folders());
		expect(folders).toHaveLength(1);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('retries a 500 and gives up with the last VanError', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(500, 'upstream exploded'));
		const err = await withTimers(
			createVanClient(config, fetchFn as never)
				.folders()
				.catch((e: unknown) => e),
		);
		expect(err).toBeInstanceOf(VanError);
		expect((err as VanError).status).toBe(500);
		expect(fetchFn).toHaveBeenCalledTimes(5);
	});

	it('retries a network-level failure', async () => {
		const fetchFn = vi
			.fn()
			.mockRejectedValueOnce(new Error('ECONNRESET'))
			.mockResolvedValueOnce(res(200, { items: [] }));
		const folders = await withTimers(createVanClient(config, fetchFn as never).folders());
		expect(folders).toEqual([]);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('surfaces a non-JSON 200 as a VanError rather than a parse crash', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(200, '<html>maintenance</html>'));
		await expect(createVanClient(config, fetchFn as never).folders()).rejects.toThrow(
			/non-JSON response/,
		);
	});

	it('caps concurrency at 2 across the whole client', async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchFn = vi.fn().mockImplementation(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 10));
			inFlight--;
			return res(200, { items: [] });
		});

		const client = createVanClient(config, fetchFn as never);
		await withTimers(Promise.all([1, 2, 3, 4, 5, 6].map((id) => client.mapRegions(id))));
		expect(peak).toBeLessThanOrEqual(2);
		expect(fetchFn).toHaveBeenCalledTimes(6);
	});

	it('posts an export job with the discovered type id', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(200, { exportJobId: 99, status: 'Pending' }));
		const job = await createVanClient(config, fetchFn as never).createExportJob({
			savedListId: 42,
			exportJobTypeId: 8,
			webhookUrl: 'https://app.example/api/internal/van-export?key=s',
		});

		expect(job.exportJobId).toBe(99);
		const [, init] = fetchFn.mock.calls[0]!;
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({
			savedListId: 42,
			type: 8,
			webhookUrl: 'https://app.example/api/internal/van-export?key=s',
		});
	});

	it('targets the route-level refresh path when given a region id', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(200, ''));
		const client = createVanClient(config, fetchFn as never);
		await client.refreshMapRegion(5);
		await client.refreshMapRegion(5, 77);
		expect(fetchFn.mock.calls[0]![0]).toBe(`${VAN_BASE_URL}/folders/5/mapRegions/refresh`);
		expect(fetchFn.mock.calls[1]![0]).toBe(`${VAN_BASE_URL}/folders/5/mapRegions/77/refresh`);
	});

	// The verb is the whole meaning of this call — a refresh issued as a GET
	// would read the region rather than re-cut it, and every door count derived
	// from it would silently stay stale. VAN documents no body, so none is sent.
	it('issues the refresh as a POST with no body', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(200, ''));
		await createVanClient(config, fetchFn as never).refreshMapRegion(5, 77);
		const [, init] = fetchFn.mock.calls[0]!;
		expect(init.method).toBe('POST');
		expect(init.body).toBeUndefined();
	});
});

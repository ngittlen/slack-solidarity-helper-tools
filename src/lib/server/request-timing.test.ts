import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import {
	SLOW_REQUEST_MS,
	requestLabel,
	timeDependency,
	timeRequest,
	timedFetch,
	timedLibsqlClient,
} from './request-timing.js';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

const statusOf = (outcome: { ok: true; value: number } | { ok: false; error: unknown }) =>
	outcome.ok ? outcome.value : null;

/** The one line logged, or undefined. */
const logged = () => warn.mock.calls[0]?.[0] as string | undefined;

describe('requestLabel', () => {
	it('uses the route id, never the URL, so the cron secret stays out of the logs', () => {
		const url = new URL('http://127.0.0.1:3000/api/internal/van-sync?key=s3cret&budget=long');
		const label = requestLabel('POST', '/api/internal/van-sync', url);
		expect(label).toBe('POST /api/internal/van-sync');
		expect(label).not.toContain('s3cret');
	});

	it('names the campaign and shared stages of a VAN sync call', () => {
		const url = new URL(
			'http://127.0.0.1:3000/api/internal/van-sync?key=s3cret&campaign=3&shared=0',
		);
		expect(requestLabel('POST', '/api/internal/van-sync', url)).toBe(
			'POST /api/internal/van-sync?campaign=3&shared=0',
		);
	});

	it('falls back to the path when no route matched', () => {
		expect(requestLabel('GET', null, new URL('http://x/favicon.ico?v=2'))).toBe('GET /favicon.ico');
	});
});

describe('timeRequest', () => {
	it('says nothing about a quick request', async () => {
		const c = clock();
		await timeRequest(
			'GET /turfs',
			async () => {
				c.advance(SLOW_REQUEST_MS - 1);
				return 200;
			},
			statusOf,
			c.now,
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it('logs a slow request with the time each dependency took', async () => {
		const c = clock();
		const call = (ms: number) => async () => {
			c.advance(ms);
		};
		await timeRequest(
			'GET /',
			async () => {
				await timeDependency('db', call(300), c.now);
				await timeDependency('db', call(100), c.now);
				await timeDependency('slack', call(31_200), c.now);
				return 200;
			},
			statusOf,
			c.now,
		);
		expect(logged()).toBe(
			'[slow] GET / → 200 in 31600ms — db 2 calls 0.4s (slowest 0.3s), ' +
				'slack 1 call 31.2s (slowest 31.2s); 0 others in flight',
		);
	});

	it('says when the time went somewhere other than a dependency', async () => {
		const c = clock();
		await timeRequest(
			'GET /turfs',
			async () => {
				c.advance(SLOW_REQUEST_MS);
				return 200;
			},
			statusOf,
			c.now,
		);
		expect(logged()).toContain('no db, slack or van calls');
	});

	it('logs a request that threw, and lets the error through', async () => {
		const c = clock();
		const boom = new Error('boom');
		await expect(
			timeRequest(
				'GET /turfs',
				async () => {
					c.advance(SLOW_REQUEST_MS);
					throw boom;
				},
				statusOf,
				c.now,
			),
		).rejects.toBe(boom);
		expect(logged()).toContain('GET /turfs → threw');
	});

	it('keeps two requests made side by side apart, and counts the other', async () => {
		const c = clock();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const sync = timeRequest(
			'POST /api/internal/van-sync?campaign=1',
			async () => {
				await timeDependency('van', () => gate, c.now);
				return 200;
			},
			statusOf,
			c.now,
		);
		await timeRequest(
			'GET /turfs',
			async () => {
				await timeDependency(
					'db',
					async () => {
						c.advance(SLOW_REQUEST_MS);
					},
					c.now,
				);
				return 200;
			},
			statusOf,
			c.now,
		);
		expect(logged()).toBe(
			'[slow] GET /turfs → 200 in 2000ms — db 1 call 2.0s (slowest 2.0s); 1 other in flight',
		);
		release();
		await sync;
		expect(warn.mock.calls[1]?.[0]).toContain('van 1 call');
		expect(warn.mock.calls[1]?.[0]).not.toContain('db');
	});
});

describe('timeDependency', () => {
	it('just runs a call made outside any request', async () => {
		await expect(timeDependency('db', async () => 7)).resolves.toBe(7);
	});
});

describe('timedFetch', () => {
	it('times the injected fetch and passes its answer through', async () => {
		const c = clock();
		const response = new Response('ok');
		const fetchFn = vi.fn(async () => {
			c.advance(SLOW_REQUEST_MS);
			return response;
		});
		const fetchVia = timedFetch('van', fetchFn as unknown as typeof fetch);
		let got: Response | undefined;
		await timeRequest(
			'POST /api/turfs/[turfId]',
			async () => {
				got = await fetchVia('https://api.securevan.com/v4/echoes');
				return 200;
			},
			statusOf,
			c.now,
		);
		expect(got).toBe(response);
		expect(fetchFn).toHaveBeenCalledWith('https://api.securevan.com/v4/echoes', undefined);
		expect(logged()).toContain('van 1 call');
	});
});

describe('timedLibsqlClient', () => {
	it('times the queries, batches and transactions drizzle makes', async () => {
		// A file, not :memory: — libsql hands its connection to a transaction
		// and opens a fresh one after, which for :memory: is a new, empty
		// database.
		const dir = mkdtempSync(join(tmpdir(), 'request-timing-'));
		const client = createClient({ url: `file:${join(dir, 'db.sqlite')}` });
		const db = drizzle(timedLibsqlClient(client));
		const c = clock();
		await timeRequest(
			'GET /turfs',
			async () => {
				await db.run(sql`create table t (n integer)`);
				await db.batch([
					db.run(sql`insert into t values (1)`),
					db.run(sql`insert into t values (2)`),
				]);
				await db.transaction(async (tx) => {
					await tx.run(sql`insert into t values (3)`);
				});
				const rows = await db.all<{ n: number }>(sql`select n from t order by n`);
				expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
				c.advance(SLOW_REQUEST_MS);
				return 200;
			},
			statusOf,
			c.now,
		);
		// create, batch, begin, insert, commit, select.
		expect(logged()).toContain('db 6 calls');
		client.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

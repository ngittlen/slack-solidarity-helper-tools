import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import {
	SLOW_CALL_MS,
	SLOW_REQUEST_MS,
	requestLabel,
	setRoundTripProbe,
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

const lines = (prefix: string) =>
	warn.mock.calls
		.map((call: unknown[]) => String(call[0]))
		.filter((line: string) => line.startsWith(prefix));
/** The first slow-request line logged, or undefined. */
const logged = (n = 0) => lines('[slow] ')[n];
/** The slow-call lines logged. */
const slowCalls = () => lines('[slow call] ');

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
				await timeDependency('db', call(100), 'select 1', c.now);
				await timeDependency(
					'db',
					call(300),
					'select "data" from "sessions" where "sid" = ?',
					c.now,
				);
				await timeDependency('slack', call(31_200), 'conversations.info', c.now);
				return 200;
			},
			statusOf,
			c.now,
		);
		expect(logged()).toBe(
			'[slow] GET / → 200 in 31600ms — db 2 calls 0.4s ' +
				'(slowest 0.3s, #2: select "data" from "sessions" where "sid" = ?), ' +
				'slack 1 call 31.2s (slowest 31.2s, #1: conversations.info); 0 others in flight',
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
				await timeDependency('van', () => gate, '', c.now);
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
					'',
					c.now,
				);
				return 200;
			},
			statusOf,
			c.now,
		);
		expect(logged()).toBe(
			'[slow] GET /turfs → 200 in 2000ms — db 1 call 2.0s (slowest 2.0s, #1); 1 other in flight',
		);
		release();
		await sync;
		expect(logged(1)).toContain('van 1 call');
		expect(logged(1)).not.toContain('db');
	});
});

describe('timeDependency', () => {
	it('just runs a call made outside any request', async () => {
		await expect(timeDependency('db', async () => 7)).resolves.toBe(7);
		expect(warn).not.toHaveBeenCalled();
	});

	it('logs a slow call on its own, with when it started and the request it was for', async () => {
		const c = clock(Date.parse('2026-10-28T23:48:53.120Z'));
		await timeRequest(
			'GET /turfs',
			async () => {
				await timeDependency(
					'db',
					async () => {
						c.advance(14_000);
					},
					'select "data" from "sessions"',
					c.now,
				);
				return 200;
			},
			statusOf,
			c.now,
		);
		expect(slowCalls()).toEqual([
			'[slow call] db 14.0s from 23:48:53.120: select "data" from "sessions" — GET /turfs',
		]);
	});

	it('logs a slow call made outside any request', async () => {
		const c = clock(Date.parse('2026-10-28T23:48:53.000Z'));
		await timeDependency(
			'db',
			async () => {
				c.advance(SLOW_CALL_MS);
			},
			'update "van_turfs"',
			c.now,
		);
		expect(slowCalls()).toEqual([
			'[slow call] db 2.0s from 23:48:53.000: update "van_turfs" — outside a request',
		]);
	});

	it('names the request that left the work running, once it has answered', async () => {
		const c = clock(Date.parse('2026-10-28T23:48:52.000Z'));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let later!: Promise<void>;
		await timeRequest(
			'POST /api/turfs/[turfId]',
			async () => {
				// Fire-and-forget, like the contact nudge: started here, still
				// running when the request answers.
				later = timeDependency(
					'db',
					async () => {
						await gate;
						c.advance(SLOW_CALL_MS);
					},
					'select 1',
					c.now,
				);
				return 200;
			},
			statusOf,
			c.now,
		);
		release();
		await later;
		expect(slowCalls()).toEqual([
			'[slow call] db 2.0s from 23:48:52.000: select 1 — after POST /api/turfs/[turfId]',
		]);
		expect(logged()).toBeUndefined();
	});

	it('leaves slow VAN calls to the request line: exports are slow by nature', async () => {
		const c = clock();
		await timeDependency(
			'van',
			async () => {
				c.advance(60_000);
			},
			'api.securevan.com/v4/exportJobs',
			c.now,
		);
		expect(slowCalls()).toEqual([]);
	});
});

describe('round-trip probe', () => {
	/** A database call held open until `release`. */
	function stalled() {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		return { call: () => gate, release };
	}

	beforeEach(() => {
		vi.useFakeTimers({ now: new Date('2026-10-30T01:24:24.000Z') });
	});

	afterEach(() => {
		setRoundTripProbe(null);
		vi.useRealTimers();
	});

	it('sends select 1 beside a db call still running at SLOW_CALL_MS, and logs its time', async () => {
		const execute = vi.fn(async () => {
			await new Promise((r) => setTimeout(r, 2140));
			return {};
		});
		setRoundTripProbe({ execute } as never);
		const { call, release } = stalled();
		const done = timeDependency('db', call, 'select "data" from "sessions"');

		await vi.advanceTimersByTimeAsync(SLOW_CALL_MS);
		expect(execute).toHaveBeenCalledWith('select 1');
		await vi.advanceTimersByTimeAsync(2140);
		release();
		await done;
		expect(lines('[db probe]')).toEqual([
			'[db probe] select 1 in 2140ms from 01:24:26.000, beside a db call 2.0s in',
		]);
	});

	it('sends one probe for calls that stall together', async () => {
		const execute = vi.fn(async () => {
			await new Promise((r) => setTimeout(r, 30));
			return {};
		});
		setRoundTripProbe({ execute } as never);
		const a = stalled();
		const b = stalled();
		const done = Promise.all([timeDependency('db', a.call), timeDependency('db', b.call)]);

		await vi.advanceTimersByTimeAsync(SLOW_CALL_MS + 30);
		a.release();
		b.release();
		await done;
		expect(execute).toHaveBeenCalledTimes(1);
		expect(lines('[db probe]')).toEqual([
			'[db probe] select 1 in 30ms from 01:24:26.000, beside a db call 2.0s in',
		]);
	});

	it('leaves quick db calls and other dependencies alone', async () => {
		const execute = vi.fn(async () => ({}));
		setRoundTripProbe({ execute } as never);
		await timeDependency('db', async () => {});
		const slack = stalled();
		const done = timeDependency('slack', slack.call, 'users.list');
		await vi.advanceTimersByTimeAsync(SLOW_CALL_MS * 2);
		slack.release();
		await done;
		expect(execute).not.toHaveBeenCalled();
	});

	it('says when the probe itself failed', async () => {
		setRoundTripProbe({
			execute: async () => {
				throw new Error('connection reset');
			},
		} as never);
		const { call, release } = stalled();
		const done = timeDependency('db', call);
		await vi.advanceTimersByTimeAsync(SLOW_CALL_MS);
		release();
		await done;
		expect(lines('[db probe]')).toEqual([
			'[db probe] select 1 failed after 0ms from 01:24:26.000, beside a db call 2.0s in: connection reset',
		]);
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
				got = await fetchVia('https://blob.example.net/exports/123.csv?sig=s3cret');
				return 200;
			},
			statusOf,
			c.now,
		);
		expect(got).toBe(response);
		expect(fetchFn).toHaveBeenCalledWith(
			'https://blob.example.net/exports/123.csv?sig=s3cret',
			undefined,
		);
		// Host and path only: a blob's query is its signed token.
		expect(logged()).toContain('#1: blob.example.net/exports/123.csv)');
		expect(logged()).not.toContain('s3cret');
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

	it('names the slowest statement, on one line and cut short', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const long = `select ${Array.from({ length: 40 }, (_, i) => `"col_${i}"`).join(', ')}\n  from "van_turfs"`;
			const fake = {
				execute: async (stmt: { sql: string }) => {
					vi.setSystemTime(Date.now() + (stmt.sql.startsWith('select "col_0"') ? 9_000 : 10));
					return { rows: [] };
				},
				batch: async () => [],
			};
			const client = timedLibsqlClient(fake as unknown as Client);
			await timeRequest(
				'GET /turfs',
				async () => {
					await client.execute({ sql: 'select 1', args: [] });
					await client.execute({ sql: long, args: [] });
					await client.batch([{ sql: 'update t set n = ?', args: [1] }], 'write');
					return 200;
				},
				statusOf,
			);
			expect(logged()).toContain(
				`db 3 calls 9.0s (slowest 9.0s, #2: ${long.replace(/\s+/g, ' ').slice(0, 80)}…)`,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('names a batch by its size and first statement', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const fake = {
				batch: async () => {
					vi.setSystemTime(Date.now() + SLOW_REQUEST_MS);
					return [];
				},
			};
			const client = timedLibsqlClient(fake as unknown as Client);
			await timeRequest(
				'POST /api/internal/van-sync',
				async () => {
					await client.batch(
						[
							{ sql: 'insert into "van_turf_roster" values (?, ?)', args: [1, 2] },
							{ sql: 'insert into "van_turf_roster" values (?, ?)', args: [3, 4] },
						],
						'write',
					);
					return 200;
				},
				statusOf,
			);
			expect(logged()).toContain('#1: batch of 2: insert into "van_turf_roster" values (?, ?)');
		} finally {
			vi.useRealTimers();
		}
	});
});

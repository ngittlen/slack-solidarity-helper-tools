// Where a slow request spent its time.
//
// Fly's charts show that responses took a minute or more (2026-10-28) while
// CPU and load sat near idle: requests were waiting, not computing. Every page
// waits on something outside the machine — Turso for every query (the session
// lookup included), Slack on the dashboard, VAN on a checkout — and nothing
// said which. So each request carries a tally, in AsyncLocalStorage, of the
// calls it made to each of them, and one that took SLOW_REQUEST_MS or more is
// logged with it:
//
//   [slow] GET / → 200 in 48210ms — db 14 calls 1.1s (slowest 0.4s), slack 23 calls 46.8s (slowest 31.2s); 2 others in flight
//
// Times are summed per call, so calls made side by side (a Promise.all) can
// add up to more than the request took. VAN's time is until response headers,
// as that is all `fetch` waits for, and excludes the client's own queue. A
// Slack call's time includes the retries @slack/web-api makes on its own.
//
// Labels are the route id, never the URL: the scheduler's calls carry the cron
// secret in their query string. Only REQUEST_LABEL_PARAMS are added back.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Client, Transaction } from '@libsql/client';

export const SLOW_REQUEST_MS = 2_000;
/** Query parameters safe and worth naming in a label: which campaign a VAN
 *  sync call is for, and whether it is the shared stages. */
const REQUEST_LABEL_PARAMS = ['campaign', 'shared'] as const;

export type Dependency = 'db' | 'slack' | 'van';
const DEPENDENCIES: readonly Dependency[] = ['db', 'slack', 'van'];

interface Tally {
	calls: number;
	totalMs: number;
	slowestMs: number;
}

interface RequestTiming {
	label: string;
	startedAt: number;
	tallies: Map<Dependency, Tally>;
}

const storage = new AsyncLocalStorage<RequestTiming>();
let inFlight = 0;

/** `GET /turfs/organizer`, or `POST /api/internal/van-sync?campaign=3`. */
export function requestLabel(method: string, routeId: string | null, url: URL): string {
	const params = REQUEST_LABEL_PARAMS.flatMap((name) => {
		const value = url.searchParams.get(name);
		return value === null ? [] : [`${name}=${value}`];
	});
	// No route id is a 404 or a static asset; the path is still not a secret.
	const path = routeId ?? url.pathname;
	return `${method} ${path}${params.length > 0 ? `?${params.join('&')}` : ''}`;
}

/**
 * Run one request with a tally, and log it if it was slow. `run` answers the
 * status the request ended with (null when it threw); its own result or error
 * passes through untouched.
 */
export async function timeRequest<T>(
	label: string,
	run: () => Promise<T>,
	statusOf: (outcome: { ok: true; value: T } | { ok: false; error: unknown }) => number | null,
	now = Date.now,
): Promise<T> {
	const timing: RequestTiming = { label, startedAt: now(), tallies: new Map() };
	inFlight++;
	let status: number | null = null;
	try {
		const value = await storage.run(timing, run);
		status = statusOf({ ok: true, value });
		return value;
	} catch (error) {
		status = statusOf({ ok: false, error });
		throw error;
	} finally {
		inFlight--;
		const ms = now() - timing.startedAt;
		if (ms >= SLOW_REQUEST_MS) console.warn(formatSlowRequest(timing, status, ms, inFlight));
	}
}

/** Time one call to a dependency against the request it is made for. Outside
 *  a request — a scheduler tick, the live contact poll — it just runs. */
export async function timeDependency<T>(
	dependency: Dependency,
	call: () => Promise<T>,
	now = Date.now,
): Promise<T> {
	const timing = storage.getStore();
	if (!timing) return call();
	const startedAt = now();
	try {
		return await call();
	} finally {
		const ms = now() - startedAt;
		const tally = timing.tallies.get(dependency) ?? { calls: 0, totalMs: 0, slowestMs: 0 };
		tally.calls++;
		tally.totalMs += ms;
		tally.slowestMs = Math.max(tally.slowestMs, ms);
		timing.tallies.set(dependency, tally);
	}
}

/** `fetch`, timed as `dependency`. For clients that take their fetch injected. */
export function timedFetch(dependency: Dependency, fetchFn: typeof fetch = fetch): typeof fetch {
	return (input, init) => timeDependency(dependency, () => fetchFn(input, init));
}

/** The libsql client's round trips, timed as `db`: what drizzle calls for a
 *  query, a batch, and each statement of a transaction. The transaction's own
 *  begin, commit and rollback count too — begin is where a write waits its
 *  turn behind another. */
export function timedLibsqlClient(client: Client): Client {
	return timeMethods(client, ['execute', 'batch', 'migrate', 'executeMultiple'], {
		transaction: (tx) =>
			timeMethods(tx as Transaction, ['execute', 'batch', 'executeMultiple', 'commit', 'rollback']),
	});
}

/** A view of `target` whose `names` methods are timed as `db`, and whose
 *  `wrapResult` methods are timed and have their result wrapped. */
function timeMethods<T extends object>(
	target: T,
	names: readonly string[],
	wrapResult: Record<string, (result: unknown) => unknown> = {},
): T {
	return new Proxy(target, {
		get(obj, prop) {
			const value: unknown = Reflect.get(obj, prop, obj);
			if (typeof value !== 'function') return value;
			const method = value as (...args: unknown[]) => unknown;
			if (typeof prop === 'string' && names.includes(prop)) {
				return (...args: unknown[]) => timeDependency('db', async () => method.apply(obj, args));
			}
			const wrap = typeof prop === 'string' ? wrapResult[prop] : undefined;
			if (wrap) {
				return async (...args: unknown[]) =>
					wrap(await timeDependency('db', async () => method.apply(obj, args)));
			}
			return method.bind(obj);
		},
	});
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function formatSlowRequest(
	timing: RequestTiming,
	status: number | null,
	ms: number,
	others: number,
): string {
	const spent = DEPENDENCIES.flatMap((dependency) => {
		const tally = timing.tallies.get(dependency);
		if (!tally) return [];
		return [
			`${dependency} ${tally.calls} call${tally.calls === 1 ? '' : 's'} ${seconds(tally.totalMs)} ` +
				`(slowest ${seconds(tally.slowestMs)})`,
		];
	});
	return (
		`[slow] ${timing.label} → ${status ?? 'threw'} in ${ms}ms — ` +
		`${spent.length > 0 ? spent.join(', ') : 'no db, slack or van calls'}; ` +
		`${others} other${others === 1 ? '' : 's'} in flight`
	);
}

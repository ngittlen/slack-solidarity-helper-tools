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
//   [slow] GET /turfs → 200 in 7309ms — db 44 calls 8.0s (slowest 6.9s, #1: select "data", "expires_at" from "sessions" where …); 0 others in flight
//
// A database or Slack call that takes SLOW_CALL_MS by itself is also logged on
// its own, with when it started and what made it — a page, or work running
// outside one (a sync's poll, the recount after a turf is walked):
//
//   [slow call] db 14.0s from 23:48:53.120: update "van_turfs" set "uncontacted_doors" = … — after POST /api/turfs/[turfId]
//
// Each dependency's slowest call is named, with its place among that
// dependency's calls: once the slow requests were seen to be one call stalling
// for seconds while the rest took tens of milliseconds, the question was which.
//
// A database call still running at SLOW_CALL_MS sends a `select 1` down the
// same connection, and logs how long that took:
//
//   [db probe] select 1 in 2140ms from 01:24:26.002, beside a db call 2.0s in
//
// Turso's own latency chart can sit flat while every call here takes seconds,
// and Fly's CPU can sit idle. A probe as slow as the stalled call puts the time
// in the round trip — the connection, the network, Turso's front door — and
// not in any statement; a quick one puts it in the stalled statement, or in
// what that statement waits behind inside the database.
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
import { errMessage } from '../err-message.js';

export const SLOW_REQUEST_MS = 2_000;
export const SLOW_CALL_MS = 2_000;
/** Query parameters safe and worth naming in a label: which campaign a VAN
 *  sync call is for, and whether it is the shared stages. */
const REQUEST_LABEL_PARAMS = ['campaign', 'shared'] as const;

export type Dependency = 'db' | 'slack' | 'van';
const DEPENDENCIES: readonly Dependency[] = ['db', 'slack', 'van'];

interface Tally {
	calls: number;
	totalMs: number;
	slowestMs: number;
	/** What the slowest call was — see `what` on timeDependency — and its
	 *  place among this dependency's calls, from 1, in the order they started.
	 *  A stall that always lands on #1 is the connection, not the statement. */
	slowest: string;
	slowestIndex: number;
}

/** Long enough to tell statements apart, short enough to keep a line a line. */
const MAX_WHAT = 80;

interface RequestTiming {
	label: string;
	startedAt: number;
	tallies: Map<Dependency, Tally>;
	/** Set once the request has answered and been logged. Calls made after it
	 *  belong to work it left running. */
	finished: boolean;
}

const storage = new AsyncLocalStorage<RequestTiming>();
let inFlight = 0;

/** The connection the round-trip probe runs on: the app's own client, before
 *  timedLibsqlClient wraps it, so a probe is in no request's tally. */
let probeClient: Pick<Client, 'execute'> | null = null;
/** One probe at a time: calls that stall together are one stall. */
let probing = false;

export function setRoundTripProbe(client: Pick<Client, 'execute'> | null): void {
	probeClient = client;
}

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
	const timing: RequestTiming = { label, startedAt: now(), tallies: new Map(), finished: false };
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
		timing.finished = true;
		inFlight--;
		const ms = now() - timing.startedAt;
		if (ms >= SLOW_REQUEST_MS) console.warn(formatSlowRequest(timing, status, ms, inFlight));
	}
}

/**
 * Time one call to a dependency against the request it is made for. Outside
 * a request — a scheduler tick, the live contact poll — it just runs.
 *
 * `what` names the call should it be the slowest: a statement, a Slack
 * method, a URL path. Never anything carrying a value or a secret.
 */
export async function timeDependency<T>(
	dependency: Dependency,
	call: () => Promise<T>,
	what = '',
	now = Date.now,
): Promise<T> {
	const timing = storage.getStore();
	if (!timing || timing.finished) return timeLoneCall(dependency, call, what, timing, now);
	const startedAt = now();
	const tally = timing.tallies.get(dependency) ?? {
		calls: 0,
		totalMs: 0,
		slowestMs: 0,
		slowest: '',
		slowestIndex: 0,
	};
	timing.tallies.set(dependency, tally);
	const index = ++tally.calls;
	try {
		return await probedCall(dependency, call, now);
	} finally {
		const ms = now() - startedAt;
		// Finished first: the request answered while this call ran on.
		logSlowCall(
			dependency,
			what,
			startedAt,
			ms,
			`${timing.finished ? 'after ' : ''}${timing.label}`,
		);
		tally.totalMs += ms;
		if (ms > tally.slowestMs || tally.slowestIndex === 0) {
			tally.slowestMs = ms;
			tally.slowest = what;
			tally.slowestIndex = index;
		}
	}
}

/** A call made outside any request, or by work a request started and did not
 *  wait for (the contact nudge after a turf is walked): no tally to add it
 *  to, but a slow one is still logged. */
async function timeLoneCall<T>(
	dependency: Dependency,
	call: () => Promise<T>,
	what: string,
	startedBy: RequestTiming | undefined,
	now: () => number,
): Promise<T> {
	const startedAt = now();
	try {
		return await probedCall(dependency, call, now);
	} finally {
		const context = startedBy ? `after ${startedBy.label}` : 'outside a request';
		logSlowCall(dependency, what, startedAt, now() - startedAt, context);
	}
}

/** `call`, with a round-trip probe sent should a database call still be
 *  running at SLOW_CALL_MS. */
async function probedCall<T>(
	dependency: Dependency,
	call: () => Promise<T>,
	now: () => number,
): Promise<T> {
	if (dependency !== 'db') return call();
	const timer = setTimeout(() => probeRoundTrip(now), SLOW_CALL_MS);
	timer.unref?.();
	try {
		return await call();
	} finally {
		clearTimeout(timer);
	}
}

function probeRoundTrip(now: () => number): void {
	const client = probeClient;
	if (!client || probing) return;
	probing = true;
	const startedAt = now();
	const from = `from ${clockTime(startedAt)}, beside a db call ${seconds(SLOW_CALL_MS)} in`;
	client
		.execute('select 1')
		.then(
			() => console.warn(`[db probe] select 1 in ${now() - startedAt}ms ${from}`),
			(err) =>
				console.warn(
					`[db probe] select 1 failed after ${now() - startedAt}ms ${from}: ${errMessage(err)}`,
				),
		)
		.finally(() => {
			probing = false;
		});
}

/**
 * One call that took SLOW_CALL_MS by itself, whoever made it. Requests that
 * stall together show up here side by side with what they stalled behind —
 * the call that started first and ran longest. Not VAN: its exports and long
 * pages are slow by nature, and no page waits on them.
 */
function logSlowCall(
	dependency: Dependency,
	what: string,
	startedAt: number,
	ms: number,
	context: string,
): void {
	if (dependency === 'van' || ms < SLOW_CALL_MS) return;
	console.warn(
		`[slow call] ${dependency} ${seconds(ms)} from ${clockTime(startedAt)}` +
			`${what ? `: ${what}` : ''} — ${context}`,
	);
}

/** `fetch`, timed as `dependency` and named by host and path — never the
 *  query, which for a VAN export's blob is a signed token. For clients that
 *  take their fetch injected. */
export function timedFetch(dependency: Dependency, fetchFn: typeof fetch = fetch): typeof fetch {
	return (input, init) =>
		timeDependency(dependency, () => fetchFn(input, init), describeUrl(input));
}

function describeUrl(input: string | URL | Request): string {
	try {
		const url = new URL(input instanceof Request ? input.url : input);
		return `${url.host}${url.pathname}`;
	} catch {
		return '';
	}
}

/** A statement's SQL, on one line and cut short. drizzle sends values as `?`
 *  parameters, so the text carries none of them. */
function describeStatement(stmt: unknown): string {
	const text = typeof stmt === 'string' ? stmt : (stmt as { sql?: unknown } | undefined)?.sql;
	if (typeof text !== 'string') return '';
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > MAX_WHAT ? `${flat.slice(0, MAX_WHAT)}…` : flat;
}

const describeBatch = (args: unknown[]) => {
	const stmts = Array.isArray(args[0]) ? args[0] : [];
	return `batch of ${stmts.length}: ${describeStatement(stmts[0])}`;
};

type Describe = (args: unknown[]) => string;

const TRANSACTION_METHODS: Record<string, Describe> = {
	execute: (args) => describeStatement(args[0]),
	batch: describeBatch,
	executeMultiple: (args) => describeStatement(args[0]),
	commit: () => 'commit',
	rollback: () => 'rollback',
};

/** The libsql client's round trips, timed as `db`: what drizzle calls for a
 *  query, a batch, and each statement of a transaction. The transaction's own
 *  begin, commit and rollback count too — begin is where a write waits its
 *  turn behind another. */
export function timedLibsqlClient(client: Client): Client {
	return timeMethods(
		client,
		{
			execute: (args) => describeStatement(args[0]),
			batch: describeBatch,
			migrate: (args) => `migrate of ${Array.isArray(args[0]) ? args[0].length : 0}`,
			executeMultiple: (args) => describeStatement(args[0]),
		},
		{
			transaction: {
				describe: () => 'begin transaction',
				wrap: (tx) => timeMethods(tx as Transaction, TRANSACTION_METHODS),
			},
		},
	);
}

/** A view of `target` whose `methods` are timed as `db`, and whose
 *  `wrapResult` methods are timed and have their result wrapped. */
function timeMethods<T extends object>(
	target: T,
	methods: Record<string, Describe>,
	wrapResult: Record<string, { describe: Describe; wrap: (result: unknown) => unknown }> = {},
): T {
	return new Proxy(target, {
		get(obj, prop) {
			const value: unknown = Reflect.get(obj, prop, obj);
			if (typeof value !== 'function') return value;
			const method = value as (...args: unknown[]) => unknown;
			const describe = typeof prop === 'string' ? methods[prop] : undefined;
			if (describe) {
				return (...args: unknown[]) =>
					timeDependency('db', async () => method.apply(obj, args), describe(args));
			}
			const wrapped = typeof prop === 'string' ? wrapResult[prop] : undefined;
			if (wrapped) {
				return async (...args: unknown[]) =>
					wrapped.wrap(
						await timeDependency('db', async () => method.apply(obj, args), wrapped.describe(args)),
					);
			}
			return method.bind(obj);
		},
	});
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
/** `01:24:26.002`, UTC like the rest of the log. */
const clockTime = (ms: number) => new Date(ms).toISOString().slice(11, 23);

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
				// No slowest until a call has finished; one still running is in
				// the [slow call] lines when it ends.
				(tally.slowestIndex > 0
					? `(slowest ${seconds(tally.slowestMs)}, #${tally.slowestIndex}` +
						`${tally.slowest ? `: ${tally.slowest}` : ''})`
					: '(none finished)'),
		];
	});
	return (
		`[slow] ${timing.label} → ${status ?? 'threw'} in ${ms}ms — ` +
		`${spent.length > 0 ? spent.join(', ') : 'no db, slack or van calls'}; ` +
		`${others} other${others === 1 ? '' : 's'} in flight`
	);
}

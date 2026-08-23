// A per-user request budget for the turf API.
//
// This exists because of a hole the chapter limiter does not close. That one
// counts DISTINCT CHAPTERS, which is right for the page — panning around one
// county is free, as it must be — but it says nothing about volume within a
// chapter. `GET /api/turfs?bbox=` caps each response at 150 rows, and that cap
// is a payload budget, not an access control: walking the bbox grid pulls a
// 1,000-turf chapter down 150 at a time in seven requests. `POST
// /api/turfs/{id}` is worse in a quieter way — its 404-vs-409 answers are an
// existence-and-status oracle, one route id at a time, with no chapter gate in
// front of it.
//
// So: a plain sliding window on requests per user. It is not trying to be
// clever. A person panning a map emits a request every few seconds at most
// (the map debounces to 250 ms and only fires when the view settles), while a
// script walking a grid or probing ids wants hundreds a minute. Any limit
// between those two numbers separates them, which is why the exact value below
// matters much less than having one at all.

/** Requests per user per window, across all turf API routes.
 *
 *  Deliberately generous: a volunteer dragging a map hard, on a flaky
 *  connection, with a couple of claims in flight, will not come close. If this
 *  ever starts refusing real people, the map is emitting far more requests
 *  than it should be and that is the bug to fix. */
export const MAX_REQUESTS = 60;
export const REQUEST_WINDOW_MS = 60_000;

export type RequestLog = Map<string, number[]>;

export interface BudgetDecision {
	allowed: boolean;
	/** Seconds until the oldest request falls out of the window. Sent as
	 *  Retry-After so a well-behaved client backs off instead of hammering. */
	retryAfterSeconds: number;
	/** Requests used in the window, counting this one. */
	used: number;
}

/** Record a request and say whether it fits in the budget. */
export function recordRequest(log: RequestLog, key: string, now: number): BudgetDecision {
	const cutoff = now - REQUEST_WINDOW_MS;
	const recent = (log.get(key) ?? []).filter((t) => t > cutoff);

	if (recent.length >= MAX_REQUESTS) {
		log.set(key, recent);
		const oldest = Math.min(...recent);
		return {
			allowed: false,
			// A refused request is NOT recorded. Otherwise a client that keeps
			// retrying pushes its own window forward forever and can never
			// recover, which turns a momentary burst into a permanent lockout.
			retryAfterSeconds: Math.max(1, Math.ceil((oldest + REQUEST_WINDOW_MS - now) / 1000)),
			used: recent.length,
		};
	}

	recent.push(now);
	log.set(key, recent);
	return { allowed: true, retryAfterSeconds: 0, used: recent.length };
}

/** Drop users whose requests have all aged out. */
export function pruneRequestLog(log: RequestLog, now: number): void {
	const cutoff = now - REQUEST_WINDOW_MS;
	for (const [key, times] of log) {
		const recent = times.filter((t) => t > cutoff);
		if (recent.length === 0) log.delete(key);
		else log.set(key, recent);
	}
}

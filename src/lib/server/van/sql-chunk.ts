// Split an id list into batches small enough for one SQL statement.
//
// `inArray(col, ids)` binds one parameter per id. SQLite caps bound parameters
// per statement — 999 in older builds, 32766 since 3.32 — and drizzle gives no
// warning before the driver rejects the statement outright. The lists this
// guards are unbounded by nature: retiring a folder retires every turf in it
// at once, and a claim sweep after an outage can find a whole day's worth.
//
// 500 is chosen to be comfortably under the *oldest* limit rather than tuned
// to the current one, because the cost of being wrong is a failed nightly job
// and the cost of being conservative is a second round trip.

export const SQL_BATCH_SIZE = 500;

export function chunked<T>(items: readonly T[], size = SQL_BATCH_SIZE): T[][] {
	if (items.length === 0) return [];
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

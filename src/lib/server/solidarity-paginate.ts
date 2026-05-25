// Shared offset paginator for Solidarity's `/v1/*` endpoints. Both the nightly
// snapshot job and the settings-page autocomplete fetchers call this.
//
// Intentionally has no `$env/*` or `$lib/*` imports so the standalone
// scripts/solidarity-snapshot.ts (which runs outside the Vite bundle via tsx)
// can resolve it by relative path. Only `fetch`, `console`, and `setTimeout`.

const PAGE_LIMIT = 100;
// Generous safety cap; callers early-terminate via a short final page.
const MAX_PAGES = 500;
// Retry budget for 429s across an entire paginated walk (not per page). The
// previous implementation did `page--; continue;` with no cap, which could
// spin forever on a persistent rate limit (FR-004a). Five retries per walk
// lets a transient burst recover without leaving the autocomplete UI hanging.
const MAX_RETRIES = 5;
// Upper bound on Retry-After honoring — a hostile or buggy upstream returning
// a huge value must not block the loader indefinitely. The retry budget still
// applies on top of this.
const MAX_RETRY_AFTER_SECONDS = 60;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

function parseRetryAfter(raw: string | null): number {
	const parsed = parseInt(raw ?? '', 10);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RETRY_AFTER_SECONDS;
	return Math.min(parsed, MAX_RETRY_AFTER_SECONDS);
}

/**
 * Walk every offset page of a Solidarity `/v1/*` resource and return the
 * concatenated `data` arrays. Honors `Retry-After` on 429 with a bounded
 * retry budget; throws once the budget is exhausted or on any non-429 error.
 *
 * `logTag` prefixes the rate-limit warn line so callers (snapshot vs.
 * autocomplete) can be distinguished in logs.
 */
export async function fetchPaginated<T>(
	apiToken: string,
	path: string,
	resourceLabel: string,
	extraQuery = '',
	logTag = 'solidarity',
): Promise<T[]> {
	const all: T[] = [];
	let retriesUsed = 0;
	for (let page = 0; page < MAX_PAGES; page++) {
		const offset = page * PAGE_LIMIT;
		const url = `https://api.solidarity.tech${path}?_limit=${PAGE_LIMIT}&_offset=${offset}${extraQuery}`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${apiToken}` },
		});
		if (res.status === 429) {
			if (retriesUsed >= MAX_RETRIES) {
				throw new Error(
					`Solidarity ${resourceLabel} rate-limit retry budget exhausted (${MAX_RETRIES} retries)`,
				);
			}
			retriesUsed++;
			const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
			console.warn(`[${logTag}] solidarity rate limited — waiting ${retryAfter}s`);
			await new Promise((r) => setTimeout(r, retryAfter * 1000));
			page--; // retry this page
			continue;
		}
		if (!res.ok) {
			throw new Error(`Solidarity ${resourceLabel} returned ${res.status}: ${await res.text()}`);
		}
		const body = (await res.json()) as { data?: T[] };
		const items = body.data ?? [];
		all.push(...items);
		if (items.length < PAGE_LIMIT) break;
	}
	return all;
}

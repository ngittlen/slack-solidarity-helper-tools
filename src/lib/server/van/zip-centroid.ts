// ZIP → centroid, for volunteers who decline or cannot use geolocation.
//
// Shaped deliberately like mobilize-migrator/lib/geocode.ts, including the
// contract that matters most: **this never throws.** A geocoder outage, a
// typo, a point in open water — all of them return null, and the caller shows
// an unsorted list instead of an error page. Distance sorting is a
// convenience; losing it must never cost someone the turf list.
//
// The Census Bureau's geocoder is used for the same reasons the migrator uses
// it: free, keyless, no account, and no terms that forbid this. Answers are
// cached in van_zip_centroids because a ZIP's location does not change and a
// canvass launch will hit the same dozen ZIPs all morning.
//
// The same endpoint takes a full street address, which is what the /turfs Slack
// command offers ("/turfs 123 Main St, Cambridge MA"). That address is the most
// sensitive string this feature handles, so two rules apply to it and are
// enforced below rather than left to callers:
//
//   1. It is NEVER persisted. Only the ZIP the geocoder reports back is written
//      to van_zip_centroids — a ZIP centroid is not personal data, and caching
//      it means an address lookup warms the same cache a ZIP lookup reads.
//   2. It is NEVER logged. geocodeZip logs the ZIP it failed on, which is fine;
//      the address path logs a redacted marker instead, because a warn line
//      carrying someone's home address outlives the request by however long the
//      log aggregator keeps it.

import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanZipCentroids } from '../schema.js';

type Db = ReturnType<typeof drizzle>;

const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
// The geocoder is occasionally slow. A volunteer standing on a street corner
// will not wait, and neither should the request.
const TIMEOUT_MS = 4000;

export interface LatLng {
	lat: number;
	lng: number;
}

/** Five digits, or null. Rejects ZIP+4, letters, and the empty string rather
 *  than passing them to the geocoder to be rejected more slowly. */
export function normalizeZip(raw: string | null | undefined): string | null {
	const trimmed = (raw ?? '').trim();
	const match = /^(\d{5})(?:-\d{4})?$/.exec(trimmed);
	return match ? match[1]! : null;
}

/** Ask the Census geocoder where a ZIP is. Never throws. */
export async function geocodeZip(
	zip: string,
	fetchFn: typeof fetch = fetch,
): Promise<LatLng | null> {
	const url = new URL(ENDPOINT);
	url.searchParams.set('address', zip);
	url.searchParams.set('benchmark', 'Public_AR_Current');
	url.searchParams.set('format', 'json');

	try {
		const res = await fetchFn(url.toString(), {
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) {
			console.warn(`[van] zip geocode for ${zip} returned ${res.status}`);
			return null;
		}
		const body = (await res.json()) as {
			result?: { addressMatches?: Array<{ coordinates?: { x?: unknown; y?: unknown } }> };
		};
		const coords = body?.result?.addressMatches?.[0]?.coordinates;
		const lng = Number(coords?.x);
		const lat = Number(coords?.y);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
		// Null island means the geocoder answered with nothing useful.
		if (lat === 0 && lng === 0) return null;
		return { lat, lng };
	} catch (err) {
		// Includes the timeout. Deliberately swallowed: see the header.
		console.warn(`[van] zip geocode for ${zip} failed:`, err instanceof Error ? err.message : err);
		return null;
	}
}

/**
 * Where a ZIP is, from cache when we have it and from the geocoder otherwise.
 *
 * A cache write failure is swallowed too — having the answer and failing to
 * store it is strictly better than failing the lookup, and the next request
 * simply asks again.
 */
export async function lookupZipCentroid(
	db: Db,
	rawZip: string | null | undefined,
	fetchFn: typeof fetch = fetch,
): Promise<LatLng | null> {
	const zip = normalizeZip(rawZip);
	if (!zip) return null;

	try {
		const [cached] = await db.select().from(vanZipCentroids).where(eq(vanZipCentroids.zip, zip));
		if (cached) return { lat: cached.lat, lng: cached.lng };
	} catch (err) {
		// A cache read failure must not stop the lookup either.
		console.warn('[van] zip cache read failed:', err instanceof Error ? err.message : err);
	}

	const point = await geocodeZip(zip, fetchFn);
	if (!point) return null;

	await cacheCentroid(db, zip, point);
	return point;
}

/** Write a ZIP's centroid to the cache. Shared by the ZIP and address paths so
 *  there is one place that decides what gets stored — which is what keeps a
 *  street address from ever reaching a column. Never throws: having the answer
 *  and failing to store it is strictly better than failing the lookup. */
async function cacheCentroid(db: Db, zip: string, point: LatLng): Promise<void> {
	const fetchedAt = new Date().toISOString();
	try {
		await db
			.insert(vanZipCentroids)
			.values({ zip, lat: point.lat, lng: point.lng, fetchedAt })
			.onConflictDoUpdate({
				target: vanZipCentroids.zip,
				set: { lat: point.lat, lng: point.lng, fetchedAt },
			});
	} catch (err) {
		console.warn('[van] zip cache write failed:', err instanceof Error ? err.message : err);
	}
}

/**
 * Where a free-text address is, plus the ZIP the geocoder matched it to.
 *
 * The ZIP is the interesting half for everything except distance sorting: it is
 * what gets cached, and it is what resolves the volunteer's chapter. It can
 * legitimately come back null — the geocoder matches some addresses without a
 * usable ZIP component — and the caller has to cope rather than treat it as a
 * failure, because the coordinates are still good.
 *
 * Never throws, per the module header.
 */
export async function geocodeAddress(
	query: string,
	fetchFn: typeof fetch = fetch,
): Promise<{ point: LatLng; zip: string | null } | null> {
	const address = query.trim();
	if (address === '') return null;

	const url = new URL(ENDPOINT);
	url.searchParams.set('address', address);
	url.searchParams.set('benchmark', 'Public_AR_Current');
	url.searchParams.set('format', 'json');

	try {
		const res = await fetchFn(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) {
			// No address in the message — see rule 2 in the header.
			console.warn(`[van] address geocode returned ${res.status}`);
			return null;
		}
		const body = (await res.json()) as {
			result?: {
				addressMatches?: Array<{
					coordinates?: { x?: unknown; y?: unknown };
					addressComponents?: { zip?: unknown };
				}>;
			};
		};
		const match = body?.result?.addressMatches?.[0];
		const lng = Number(match?.coordinates?.x);
		const lat = Number(match?.coordinates?.y);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
		// Null island means the geocoder answered with nothing useful.
		if (lat === 0 && lng === 0) return null;
		return { point: { lat, lng }, zip: normalizeZip(String(match?.addressComponents?.zip ?? '')) };
	} catch (err) {
		// The timeout lands here. Swallowed, and the error is not logged with it:
		// an AbortError carries no address, but a URL-bearing fetch error would.
		console.warn('[van] address geocode failed:', err instanceof Error ? err.name : 'unknown');
		return null;
	}
}

/**
 * Where the volunteer says they are, from either a ZIP or a street address.
 *
 * One entry point rather than two, so the caller never has to decide which kind
 * of input it holds — and so the caching rule (ZIP only, never the address) is
 * applied in exactly one place.
 *
 * Never throws.
 */
export async function resolveLocation(
	db: Db,
	raw: string | null | undefined,
	fetchFn: typeof fetch = fetch,
): Promise<{ point: LatLng; zip: string | null } | null> {
	const trimmed = (raw ?? '').trim();
	if (trimmed === '') return null;

	// A bare ZIP takes the cached path, which is the common case on a canvass
	// morning and costs no network call at all after the first volunteer.
	const zip = normalizeZip(trimmed);
	if (zip) {
		const point = await lookupZipCentroid(db, zip, fetchFn);
		return point ? { point, zip } : null;
	}

	const match = await geocodeAddress(trimmed, fetchFn);
	if (!match) return null;

	// Cache under the matched ZIP, so the street address leaves no trace but the
	// next person who types that ZIP gets a free answer.
	if (match.zip) await cacheCentroid(db, match.zip, match.point);
	return match;
}

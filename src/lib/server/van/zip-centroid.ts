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

	try {
		await db
			.insert(vanZipCentroids)
			.values({ zip, lat: point.lat, lng: point.lng, fetchedAt: new Date().toISOString() })
			.onConflictDoUpdate({
				target: vanZipCentroids.zip,
				set: { lat: point.lat, lng: point.lng, fetchedAt: new Date().toISOString() },
			});
	} catch (err) {
		console.warn('[van] zip cache write failed:', err instanceof Error ? err.message : err);
	}

	return point;
}

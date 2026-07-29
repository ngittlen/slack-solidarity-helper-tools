// Postal codes for events Solidarity gives no postal code for.
//
// `location.postal_code` is the ONE required field in Mobilize's v1 location
// object ("Required if is_virtual is false or unset … all other location fields
// are optional"), and roughly a third of the campaign's sessions carry only a
// Google-formatted address string with no zip in it — a create or update for one
// of those is rejected with 400 "postal_code: This field may not be blank".
//
// Every one of those sessions does carry coordinates, so the zip is recovered
// from those: the Census Bureau's geocoder maps a point to its ZCTA (Zip Code
// Tabulation Area), which for a street address is the zip. It is free, keyless
// and needs no account, which is why it is preferred over Google/Mapbox here.
//
// Results are cached by caller (see the Ledger) — a venue's zip does not change,
// and the campaign runs the same handful of field offices all season.

const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';

export interface Coordinates {
	lat: number;
	lng: number;
}

/** Cache key for a point. Five decimals is ~1m — far below zip resolution, and
 *  stable for the identical coordinates Solidarity repeats across sessions. */
export function pointKey(point: Coordinates): string {
	return `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
}

/** Parses the JSON-encoded `{"lat":42.98,"lng":-83.67}` Solidarity stores. */
export function parseCoordinates(raw: string | null | undefined): Coordinates | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { lat?: unknown; lng?: unknown };
		const lat = Number(parsed.lat);
		const lng = Number(parsed.lng);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
		if (lat === 0 && lng === 0) return null; // null island, not Michigan
		return { lat, lng };
	} catch {
		return null;
	}
}

/**
 * Point -> five-digit zip, or null when the geocoder has no answer (a point in
 * open water, or the service being down). Callers treat null as "cannot sync
 * this event yet" rather than sending a blank, which Mobilize rejects anyway.
 */
export async function lookupPostalCode(point: Coordinates): Promise<string | null> {
	const url = new URL(ENDPOINT);
	url.searchParams.set('x', String(point.lng));
	url.searchParams.set('y', String(point.lat));
	url.searchParams.set('benchmark', 'Public_AR_Current');
	url.searchParams.set('vintage', 'Census2020_Current');
	url.searchParams.set('layers', 'all');
	url.searchParams.set('format', 'json');

	let body: unknown;
	try {
		const res = await fetch(url);
		if (!res.ok) return null;
		body = await res.json();
	} catch {
		// A geocoder outage must not take the whole nightly sync down with it.
		return null;
	}

	const geographies = (body as { result?: { geographies?: Record<string, unknown> } })?.result
		?.geographies;
	if (!geographies) return null;
	// The layer is named "Zip Code Tabulation Areas", but the vintage prefixes
	// vary between benchmarks, so match on the name rather than pinning it.
	const key = Object.keys(geographies).find((name) => /zip code tabulation/i.test(name));
	if (!key) return null;
	const areas = geographies[key];
	if (!Array.isArray(areas) || areas.length === 0) return null;
	const zip = String((areas[0] as { ZCTA5?: unknown; BASENAME?: unknown }).ZCTA5 ?? '').trim();
	return /^\d{5}$/.test(zip) ? zip : null;
}

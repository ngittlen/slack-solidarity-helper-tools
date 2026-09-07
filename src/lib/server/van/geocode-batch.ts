// Census Bureau batch geocoder: street addresses in, coordinates out.
//
// This exists because VAN does not always populate VAddressLatitude /
// VAddressLongitude. Where it does, this file is never called — VAN's own
// coordinates are always preferred, being both free and already inside the
// trust boundary. This is the fallback for turf VAN never geocoded, which
// would otherwise have no shape at all.
//
// It runs automatically, with no configuration switch. The narrowing is per
// row, not per deployment: `hull-extract.ts` collects an address ONLY for a
// row whose coordinate columns were empty, and skips this file entirely when
// no row needed it. A fully geocoded turf therefore discloses nothing without
// anyone having to remember a setting — but a turf VAN has not geocoded WILL
// have its addresses sent, on every deployment, without further prompting.
//
// ─────────────────────────────────────────────────────────────────────────
// PRIVACY. Read this before changing anything here.
//
// Calling this transmits voter street addresses to a third party (the US
// Census Bureau). That is a deliberate, documented decision, not an
// implementation detail: see PRIVACY.md § "Turf map shapes" and item 2 of the
// data-handling posture in specs/010-van-turf-checkout/plan.md §3. It is the
// one place in this feature where per-person data leaves our servers, and it
// is on by default — so PRIVACY.md must stay accurate about it.
//
// The rules that keep it defensible are enforced here rather than left to
// callers:
//
//   1. ONLY address components are sent — street, city, state, ZIP. Never a
//      name, DOB, party, phone, email or VanID. The caller's column mask in
//      hull-extract.ts is the first line of this; `AddressLookup` having no
//      field to put a name in is the second.
//   2. Addresses are NEVER logged, at any level. Errors log counts and status
//      codes. A warn line carrying someone's home address outlives the request
//      by however long the log aggregator keeps it — the same rule
//      zip-centroid.ts already applies to the one address a volunteer types.
//   3. Addresses are NEVER persisted. They exist in memory for the life of one
//      export job and are dropped with it. Only the derived hull is stored.
//   4. The row id sent as the batch key is a synthetic index, not the VanID,
//      so the file handed to Census carries no identifier that means anything
//      outside this request.
//   5. Only rows VAN left without coordinates are sent. This is the whole of
//      the "don't send more than necessary" control now that there is no
//      switch, which makes the emptiness check in hull-extract.ts
//      privacy-relevant rather than merely a parsing detail.
// ─────────────────────────────────────────────────────────────────────────
//
// Never throws, matching zip-centroid.ts: a geocoder outage means a turf
// renders as a pin, never a failed sync.

import type { LatLng } from '../../van/geometry.js';

const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const BENCHMARK = 'Public_AR_Current';

/** Census documents 10,000 records per file. Chunked well below that so a
 *  single request stays inside the worker's time budget — a full-size batch
 *  can take minutes, and a turf is rarely more than a few hundred doors. */
export const MAX_BATCH = 1000;

/** Batches per turf. Bounds both memory and the blast radius of a turf whose
 *  saved list is far larger than any real walking route. */
export const MAX_BATCHES = 5;

/** Census is slow on batch work; this is generous by design and still bounded
 *  so a hung request cannot eat the whole sync. It is a CEILING, not the budget:
 *  a caller passing a deadline gets whichever is smaller. */
const TIMEOUT_MS = 60_000;

/** Below this there is not enough time left to get an answer, so the batch is
 *  not started at all. A request aborted at three seconds costs the same
 *  latency as one that succeeds and returns nothing. */
const MIN_REQUEST_MS = 5_000;

/** One address to resolve. Deliberately has nowhere to put a name — see rule 1
 *  in the header. `id` is a synthetic per-request index, never a VanID. */
export interface AddressLookup {
	id: string;
	street: string;
	city: string;
	state: string;
	zip: string;
}

/** Escape one CSV field for the upload. Census wants plain comma-separated
 *  values with no header row. */
function csvField(value: string): string {
	const clean = value.replace(/[\r\n]+/g, ' ').trim();
	return /[",]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean;
}

function toCsv(rows: readonly AddressLookup[]): string {
	return rows
		.map((r) => [r.id, r.street, r.city, r.state, r.zip].map(csvField).join(','))
		.join('\n');
}

/** Split a Census response line into fields, honouring quotes. The matched
 *  address it echoes back contains commas, so a naive split loses the
 *  coordinates. */
function splitCsvLine(line: string): string[] {
	const out: string[] = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (inQuotes) {
			if (char === '"') {
				if (line[i + 1] === '"') {
					field += '"';
					i++;
				} else inQuotes = false;
			} else field += char;
		} else if (char === '"' && field === '') inQuotes = true;
		else if (char === ',') {
			out.push(field);
			field = '';
		} else field += char;
	}
	out.push(field);
	return out;
}

/**
 * Parse the batch response.
 *
 * Format, one line per input row:
 *   "id","input address","Match","Exact","matched address","lng,lat","tiger","side"
 * A miss is shorter:
 *   "id","input address","No_Match"
 *
 * Note the coordinate pair is LONGITUDE FIRST — the opposite of every other
 * coordinate in this codebase, and a silent way to plot turf in the Indian
 * Ocean if assumed otherwise.
 */
export function parseBatchResponse(body: string): Map<string, LatLng> {
	const found = new Map<string, LatLng>();
	for (const line of body.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const fields = splitCsvLine(line);
		const id = fields[0];
		if (!id || fields[2] !== 'Match') continue;
		const pair = (fields[5] ?? '').split(',');
		const lng = Number(pair[0]);
		const lat = Number(pair[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
		if (lat === 0 && lng === 0) continue;
		if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
		found.set(id, { lat, lng });
	}
	return found;
}

/** One batch request. Never throws; a failure yields an empty map. */
async function geocodeChunk(
	rows: readonly AddressLookup[],
	fetchFn: typeof fetch,
	timeoutMs: number,
): Promise<Map<string, LatLng>> {
	const form = new FormData();
	form.append('benchmark', BENCHMARK);
	form.append(
		'addressFile',
		new Blob([toCsv(rows)], { type: 'text/csv' }),
		// A fixed, meaningless filename: Census requires one, and anything
		// derived from the turf would put campaign detail in a third party's
		// request logs for no benefit.
		'addresses.csv',
	);

	try {
		const res = await fetchFn(ENDPOINT, {
			method: 'POST',
			body: form,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) {
			// Counts and status only — never the addresses. See rule 2.
			console.warn(`[van] census batch geocode returned ${res.status} for ${rows.length} row(s)`);
			return new Map();
		}
		return parseBatchResponse(await res.text());
	} catch (err) {
		console.warn(
			`[van] census batch geocode failed for ${rows.length} row(s):`,
			err instanceof Error ? err.message : err,
		);
		return new Map();
	}
}

export interface GeocodeBatchOptions {
	/** Wall-clock `Date.now()` after which no further batch is started, and
	 *  which caps each request's own timeout.
	 *
	 *  Without it this is the one part of a geometry run that the worker's time
	 *  budget does not reach: MAX_BATCHES requests at TIMEOUT_MS each is five
	 *  minutes for a single turf, which is longer than the whole request the
	 *  scheduled sync is allowed. The budget is checked between batches rather
	 *  than only at the start, because the overrun is cumulative. */
	deadline?: number;
}

/**
 * Resolve addresses to coordinates, in batches.
 *
 * Returns only what matched: a miss is simply absent from the map, and the
 * caller treats it the same as a row VAN never geocoded — so running out of
 * time degrades to a coarser hull, never to a failure.
 */
export async function geocodeAddresses(
	rows: readonly AddressLookup[],
	fetchFn: typeof fetch = fetch,
	options: GeocodeBatchOptions = {},
): Promise<Map<string, LatLng>> {
	const found = new Map<string, LatLng>();
	if (rows.length === 0) return found;

	const capped = rows.slice(0, MAX_BATCH * MAX_BATCHES);
	if (capped.length < rows.length) {
		console.warn(
			`[van] census batch geocode: ${rows.length} address(es) exceeds the cap, using ${capped.length}`,
		);
	}

	for (let start = 0; start < capped.length; start += MAX_BATCH) {
		const timeoutMs =
			options.deadline === undefined
				? TIMEOUT_MS
				: Math.min(TIMEOUT_MS, options.deadline - Date.now());
		if (timeoutMs < MIN_REQUEST_MS) {
			// Counts only — never the addresses. See rule 2.
			console.warn(
				`[van] census batch geocode: out of time with ${capped.length - start} address(es) ` +
					`unresolved; the hull is built from what VAN had already geocoded`,
			);
			break;
		}
		const chunk = capped.slice(start, start + MAX_BATCH);
		for (const [id, point] of await geocodeChunk(chunk, fetchFn, timeoutMs)) found.set(id, point);
	}
	return found;
}

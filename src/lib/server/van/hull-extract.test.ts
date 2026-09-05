import { describe, it, expect } from 'vitest';
import {
	ADDRESS_COLUMNS,
	csvRows,
	extractHull,
	FORBIDDEN_COLUMNS,
	HullExtractError,
	LAT_COLUMN,
	LNG_COLUMN,
	MAX_HULL_EXTENT_M,
} from './hull-extract.js';

/** Feed a string as one chunk. */
async function* one(text: string): AsyncGenerator<string> {
	yield text;
}

/** Feed a string split at every `size` characters, so a field, a quoted
 *  section or a line ending can land across a chunk boundary. */
async function* sliced(text: string, size: number): AsyncGenerator<string> {
	for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of gen) out.push(item);
	return out;
}

// The real header from export job type 5 (VoterCircle), copied from a live
// response. 43 columns, most of them PII — which is the situation the masking
// exists for, so the fixture must not be a tidied-down version of it.
const LIVE_HEADER =
	'CanvassFileRequestID,VanID,County,Phone,PhoneDialingPrefix,PhoneCountryCode,Address,' +
	'StateFileID,CountyFileID,FirstName,LastName,StreetNo,StreetName,City,State,ZipCode,' +
	'StateOrProvince,ZipOrPostal,VAddressLatitude,VAddressLongitude,Email,HomePhone,' +
	'HomePhoneDialingPrefix,HomePhoneCountryCode,CellPhone,CellPhoneDialingPrefix,' +
	'CellPhoneCountryCode,WorkPhone,WorkPhoneDialingPrefix,WorkPhoneCountryCode,Sex,Party,DOB,' +
	'CongressionalDistrict,StateSenate,StateHouse,PollingLocation,PollingAddress,PollingCity,' +
	'PollingZip,PermanentAbsentee,VoterVANID,MyCampaignID';

/** A live-shaped row: quoted address containing commas, a real name, a DOB,
 *  and coordinates at the type-5 positions (18 and 19). */
function liveRow(lat: string, lng: string): string {
	return (
		`255849,568504,Orange,,,,"4190 S Kirkman Rd Apt 912 , Orlando, FL 32811",1675579,,` +
		`Ron,Campbell,4190,Kirkman,Orlando,FL,32811,,32811,${lat},${lng},,,,,,,,,,,` +
		`M,D,1968-08-09,008,009,036,,,,,,,`
	);
}

describe('csvRows', () => {
	it('drops every masked field at the delimiter, so PII never reaches the row', async () => {
		// Mask to the two coordinate columns, exactly as extractHull does after
		// reading the header.
		const rows = await collect(csvRows(one(liveRow('28.5', '-81.4')), () => new Set([18, 19])));

		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row[18]).toBe('28.5');
		expect(row[19]).toBe('-81.4');

		// Nothing else survived. Asserting on the joined row catches a field
		// leaking into the wrong index as well as one being kept outright.
		const leaked = row.filter((_, i) => i !== 18 && i !== 19).filter((cell) => cell !== '');
		expect(leaked).toEqual([]);
		expect(row.join('')).not.toMatch(/Campbell|Kirkman|Orlando|1968/);
	});

	it('keeps every field when the mask is null, so the header can be read', async () => {
		const rows = await collect(csvRows(one(LIVE_HEADER), () => null));
		expect(rows[0]).toContain(LAT_COLUMN);
		expect(rows[0]).toContain(LNG_COLUMN);
		expect(rows[0]).toHaveLength(43);
	});

	it('parses quoted commas, doubled quotes and CRLF', async () => {
		const text = 'a,b,c\r\n"x, y","he said ""hi""",z\r\n';
		const rows = await collect(csvRows(one(text), () => null));
		expect(rows).toEqual([
			['a', 'b', 'c'],
			['x, y', 'he said "hi"', 'z'],
		]);
	});

	it('yields a final row when the file does not end in a newline', async () => {
		const rows = await collect(csvRows(one('a,b\n1,2'), () => null));
		expect(rows).toEqual([
			['a', 'b'],
			['1', '2'],
		]);
	});

	// The parser is fed whatever the socket hands it, so correctness must not
	// depend on a chunk ending at a tidy boundary. One character at a time is
	// the cruellest case and the cheapest to assert.
	it('is invariant to chunk boundaries', async () => {
		const text = `${LIVE_HEADER}\r\n${liveRow('28.5', '-81.4')}\r\n`;
		const whole = await collect(csvRows(one(text), () => null));
		for (const size of [1, 3, 17, 64]) {
			const split = await collect(csvRows(sliced(text, size), () => null));
			expect(split, `chunk size ${size}`).toEqual(whole);
		}
	});
});

describe('extractHull', () => {
	function csv(rows: string[]): string {
		return `${LIVE_HEADER}\r\n${rows.join('\r\n')}\r\n`;
	}

	it('builds a hull from live-shaped rows and keeps no PII', async () => {
		const result = await extractHull(
			one(
				csv([
					liveRow('28.500', '-81.400'),
					liveRow('28.510', '-81.400'),
					liveRow('28.510', '-81.390'),
					liveRow('28.500', '-81.390'),
					liveRow('28.505', '-81.395'), // interior, must not be a vertex
				]),
			),
		);

		expect(result.rowCount).toBe(5);
		expect(result.hull).toHaveLength(4);
		expect(result.pointCount).toBe(5);
		expect(JSON.stringify(result.hull)).not.toMatch(/Campbell|Orlando/);
		expect(result.centre).toEqual({ lat: 28.505, lng: -81.395 });
	});

	it('rounds stored coordinates to 5 decimal places', async () => {
		const result = await extractHull(
			one(
				csv([
					liveRow('28.5000012345', '-81.4000012345'),
					liveRow('28.5100067891', '-81.4000012345'),
					liveRow('28.5100067891', '-81.3900067891'),
				]),
			),
		);
		for (const point of result.hull) {
			expect(String(point.lat).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(5);
			expect(String(point.lng).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(5);
		}
	});

	// VAN leaves both columns empty for an address it never geocoded. `Number('')`
	// is 0, which is a valid coordinate off West Africa — so a turf in Orlando
	// would otherwise get a hull stretching into the Atlantic.
	it('treats empty coordinate columns as missing, not as 0,0', async () => {
		const result = await extractHull(
			one(
				csv([
					liveRow('28.500', '-81.400'),
					liveRow('', ''),
					liveRow('28.510', '-81.390'),
					liveRow(' ', ' '),
				]),
			),
		);
		expect(result.rowCount).toBe(4);
		expect(result.rowsWithoutCoordinates).toBe(2);
		expect(result.pointCount).toBe(2);
		for (const point of result.hull) {
			expect(point.lat).toBeGreaterThan(28);
		}
		expect(result.centre!.lat).toBeGreaterThan(28);
	});

	it('rejects out-of-range coordinates', async () => {
		const result = await extractHull(
			one(csv([liveRow('28.5', '-81.4'), liveRow('91.2', '-81.4'), liveRow('28.5', '181.9')])),
		);
		expect(result.rowsWithoutCoordinates).toBe(2);
		expect(result.pointCount).toBe(1);
	});

	// Degenerate inputs must produce "no shape", not a broken polygon — the UI
	// contract is that an empty hull plus a centroid renders a pin.
	it('returns an empty hull but a usable centre for fewer than three points', async () => {
		const result = await extractHull(
			one(csv([liveRow('28.5', '-81.4'), liveRow('28.6', '-81.3')])),
		);
		expect(result.hull).toEqual([]);
		expect(result.centre).toEqual({ lat: 28.55, lng: -81.35 });
	});

	it('returns an empty hull for collinear points', async () => {
		const result = await extractHull(
			one(csv([liveRow('28.5', '-81.4'), liveRow('28.6', '-81.4'), liveRow('28.7', '-81.4')])),
		);
		expect(result.hull).toEqual([]);
		expect(result.centre).not.toBeNull();
	});

	it('drops a wild geocode before it can drag the hull across the county', async () => {
		const cluster = Array.from({ length: 20 }, (_, i) =>
			liveRow(String(28.5 + i * 0.0001), String(-81.4 + (i % 5) * 0.0001)),
		);
		const tight = await extractHull(one(csv(cluster)));
		const withOutlier = await extractHull(one(csv([...cluster, liveRow('40.7', '-74.0')])));

		expect(withOutlier.outliersDropped).toBe(1);
		expect(withOutlier.hull).toEqual(tight.hull);
	});

	it('throws when the coordinate columns are absent', async () => {
		// The type-4 (SavedListExport) header — the misconfiguration this
		// message is written for.
		await expect(extractHull(one('CanvassFileRequestID,VanID\r\n255848,3328\r\n'))).rejects.toThrow(
			HullExtractError,
		);
		await expect(extractHull(one('CanvassFileRequestID,VanID\r\n255848,3328\r\n'))).rejects.toThrow(
			/VAddressLatitude and VAddressLongitude/,
		);
	});

	it('throws on an empty file', async () => {
		await expect(extractHull(one(''))).rejects.toThrow(/no header row/);
	});

	it('matches column names case-insensitively', async () => {
		const result = await extractHull(one('vaddresslatitude,VADDRESSLONGITUDE\r\n28.5,-81.4\r\n'));
		expect(result.pointCount).toBe(1);
	});

	it('produces the same hull however the stream is chunked', async () => {
		const text = csv([
			liveRow('28.500', '-81.400'),
			liveRow('28.510', '-81.400'),
			liveRow('28.510', '-81.390'),
		]);
		const whole = await extractHull(one(text));
		for (const size of [1, 7, 128]) {
			expect((await extractHull(sliced(text, size))).hull, `chunk size ${size}`).toEqual(
				whole.hull,
			);
		}
	});
});

// Address geocoding widens the column mask, which is the one change in this
// file that can turn a parsing bug into a disclosure. These tests exist to make
// that boundary explicit and to fail loudly if it moves.
describe('extractHull with address geocoding', () => {
	function csv(rows: string[]): string {
		return `${LIVE_HEADER}\r\n${rows.join('\r\n')}\r\n`;
	}

	/** Records exactly what would be sent to Census. */
	function spyGeocoder(answers: Record<string, { lat: number; lng: number }> = {}) {
		const seen: Array<Record<string, string>> = [];
		const fn = async (rows: readonly { id: string }[]) => {
			for (const row of rows) seen.push({ ...row } as Record<string, string>);
			const out = new Map<string, { lat: number; lng: number }>();
			for (const row of rows) if (answers[row.id]) out.set(row.id, answers[row.id]!);
			return out;
		};
		return { fn, seen };
	}

	// The default. Without a geocoder the mask never widens, so no address is
	// held in memory at all — "we send nothing to Census" is true by
	// construction rather than by configuration.
	it('reads no address at all when no geocoder is supplied', async () => {
		const result = await extractHull(one(csv([liveRow('', '')])));
		expect(result.rowsWithoutCoordinates).toBe(1);
		expect(result.geocodedFromAddress).toBe(0);
	});

	it('sends only ungeocoded rows, never ones VAN already placed', async () => {
		const geocoder = spyGeocoder();
		await extractHull(
			one(csv([liveRow('28.5', '-81.4'), liveRow('', ''), liveRow('28.51', '-81.39')])),
			{ geocode: geocoder.fn },
		);
		expect(geocoder.seen).toHaveLength(1);
	});

	// The security assertion. The mask admits four address columns; it must
	// still refuse every identity column in the real 43-column header.
	it('never lets a name, DOB, party, phone, email or VanID reach the geocoder', async () => {
		const geocoder = spyGeocoder();
		await extractHull(one(csv([liveRow('', '')])), { geocode: geocoder.fn });

		expect(geocoder.seen).toHaveLength(1);
		const sent = JSON.stringify(geocoder.seen[0]);
		for (const token of ['Campbell', 'Ron', '1968-08-09', '568504', '255849']) {
			expect(sent, `"${token}" must not be sent`).not.toContain(token);
		}
		// Only the documented keys exist on the lookup at all.
		expect(Object.keys(geocoder.seen[0]!).sort()).toEqual(['city', 'id', 'state', 'street', 'zip']);
	});

	// Guards the constant itself: if someone adds a column to ADDRESS_COLUMNS,
	// this fails unless it is genuinely an address component.
	it('keeps ADDRESS_COLUMNS and FORBIDDEN_COLUMNS disjoint', () => {
		for (const column of ADDRESS_COLUMNS) {
			expect(FORBIDDEN_COLUMNS as readonly string[]).not.toContain(column);
		}
		// And every forbidden column really is in the live header, so the list
		// is describing this export rather than a hypothetical one.
		const header = LIVE_HEADER.split(',');
		for (const column of FORBIDDEN_COLUMNS) expect(header).toContain(column);
	});

	it('takes the street from Address up to the first comma', async () => {
		const geocoder = spyGeocoder();
		await extractHull(one(csv([liveRow('', '')])), { geocode: geocoder.fn });
		expect(geocoder.seen[0]).toMatchObject({
			street: '4190 S Kirkman Rd Apt 912',
			city: 'Orlando',
			state: 'FL',
			zip: '32811',
		});
	});

	// The id is a per-export ordinal, so the file handed to Census carries no
	// identifier that means anything outside the request.
	it('keys rows by ordinal, not by VanID', async () => {
		const geocoder = spyGeocoder();
		await extractHull(one(csv([liveRow('28.5', '-81.4'), liveRow('', '')])), {
			geocode: geocoder.fn,
		});
		expect(geocoder.seen[0]!.id).toBe('2');
	});

	it('folds geocoded points into the hull', async () => {
		const geocoder = spyGeocoder({
			'1': { lat: 28.5, lng: -81.4 },
			'2': { lat: 28.51, lng: -81.4 },
			'3': { lat: 28.51, lng: -81.39 },
			'4': { lat: 28.5, lng: -81.39 },
		});
		const result = await extractHull(
			one(csv([liveRow('', ''), liveRow('', ''), liveRow('', ''), liveRow('', '')])),
			{ geocode: geocoder.fn },
		);

		expect(result.geocodedFromAddress).toBe(4);
		expect(result.hull).toHaveLength(4);
		expect(result.centre).not.toBeNull();
	});

	it('treats an unmatched address the same as a row VAN never geocoded', async () => {
		const geocoder = spyGeocoder({});
		const result = await extractHull(one(csv([liveRow('', ''), liveRow('', '')])), {
			geocode: geocoder.fn,
		});
		expect(result.geocodedFromAddress).toBe(0);
		expect(result.centre).toBeNull();
		expect(result.hull).toEqual([]);
	});

	it('skips a row with no street rather than geocoding a bare city', async () => {
		const noStreet = liveRow('', '').replace('"4190 S Kirkman Rd Apt 912 , Orlando, FL 32811"', '');
		const geocoder = spyGeocoder();
		await extractHull(one(csv([noStreet])), { geocode: geocoder.fn });
		expect(geocoder.seen).toHaveLength(0);
	});
});

// A convex hull is only meaningful if the points it wraps are a walkable turf.
// Both live demo saved lists turned out to be scattered voters spanning ~40 km,
// which produces a shape that claims a whole county.
describe('extractHull hull extent bound', () => {
	function csv(rows: string[]): string {
		return `${LIVE_HEADER}\r\n${rows.join('\r\n')}\r\n`;
	}

	it('keeps a hull that spans a walkable distance', async () => {
		// ~400 m across.
		const result = await extractHull(
			one(
				csv([
					liveRow('28.5000', '-81.4000'),
					liveRow('28.5036', '-81.4000'),
					liveRow('28.5036', '-81.3960'),
					liveRow('28.5000', '-81.3960'),
				]),
			),
		);
		expect(result.hull).toHaveLength(4);
		expect(result.hullTooLarge).toBe(false);
		expect(result.hullExtentMeters).toBeLessThan(1000);
	});

	// The live demo shape: ~58 km across. Flagged, but still returned — the
	// check cannot tell "the shape is wrong" from "the turf really is enormous",
	// and blanking the geometry left an operator with a pin and no way to see
	// why.
	it('flags a county-sized hull without discarding it', async () => {
		const result = await extractHull(
			one(
				csv([
					liveRow('28.34956', '-81.58047'),
					liveRow('28.72072', '-81.58047'),
					liveRow('28.72072', '-81.16984'),
					liveRow('28.34956', '-81.16984'),
				]),
			),
		);
		expect(result.hullTooLarge).toBe(true);
		expect(result.hull).toHaveLength(4);
		expect(result.centre).not.toBeNull();
		expect(result.hullExtentMeters).toBeGreaterThan(MAX_HULL_EXTENT_M);
	});

	it('reports the extent on an implausibly large hull', async () => {
		const result = await extractHull(
			one(
				csv([
					liveRow('28.0', '-81.5'),
					liveRow('29.0', '-81.5'),
					liveRow('29.0', '-81.0'),
					liveRow('28.0', '-81.0'),
				]),
			),
		);
		expect(result.hullExtentMeters).toBeGreaterThan(100_000);
		expect(result.hullTooLarge).toBe(true);
	});

	it('reports a null extent when there was no hull to measure', async () => {
		const result = await extractHull(one(csv([liveRow('28.5', '-81.4')])));
		expect(result.hullExtentMeters).toBeNull();
		expect(result.hullTooLarge).toBe(false);
	});

	// The bound is a backstop for scattered data, not a replacement for the
	// outlier filter — one bad geocode should still be dropped, leaving a hull
	// that passes rather than one that gets refused wholesale.
	it('lets the outlier filter handle a single bad geocode first', async () => {
		const cluster = Array.from({ length: 20 }, (_, i) =>
			liveRow(String(28.5 + i * 0.0002), String(-81.4 + (i % 5) * 0.0002)),
		);
		const result = await extractHull(one(csv([...cluster, liveRow('40.7', '-74.0')])));
		expect(result.outliersDropped).toBe(1);
		expect(result.hullTooLarge).toBe(false);
		expect(result.hull.length).toBeGreaterThanOrEqual(3);
	});
});

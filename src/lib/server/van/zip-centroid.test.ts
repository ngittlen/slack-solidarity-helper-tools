import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	geocodeAddress,
	geocodeZip,
	lookupZipCentroid,
	normalizeZip,
	resolveLocation,
} from './zip-centroid.js';

function res(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

const MATCH = {
	result: { addressMatches: [{ coordinates: { x: -83.743, y: 42.281 } }] },
};

/** Records what was written, and can be made to fail on read or write. */
function makeDb(
	cached: unknown[] = [],
	opts: { readThrows?: boolean; writeThrows?: boolean } = {},
) {
	const written: unknown[] = [];
	return {
		written,
		db: {
			select: () => ({
				from: () => ({
					where: async () => {
						if (opts.readThrows) throw new Error('db down');
						return cached;
					},
				}),
			}),
			insert: () => ({
				values: (row: unknown) => ({
					onConflictDoUpdate: async () => {
						if (opts.writeThrows) throw new Error('db down');
						written.push(row);
					},
				}),
			}),
		} as never,
	};
}

describe('normalizeZip', () => {
	it('accepts five digits', () => {
		expect(normalizeZip('48104')).toBe('48104');
	});
	it('trims whitespace', () => {
		expect(normalizeZip('  48104 ')).toBe('48104');
	});
	it('takes the five-digit half of a ZIP+4', () => {
		expect(normalizeZip('48104-1234')).toBe('48104');
	});
	it.each([
		['', ''],
		['too short', '4810'],
		['letters', 'ann arbor'],
		['null', null],
	])('rejects %s', (_label, raw) => {
		expect(normalizeZip(raw)).toBeNull();
	});
});

describe('geocodeZip', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('returns the point the geocoder gives', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(200, MATCH));
		expect(await geocodeZip('48104', fetchFn as never)).toEqual({ lat: 42.281, lng: -83.743 });
	});

	it('sends the ZIP to the Census geocoder', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(200, MATCH));
		await geocodeZip('48104', fetchFn as never);
		expect(String(fetchFn.mock.calls[0]![0])).toContain('geocoding.geo.census.gov');
		expect(String(fetchFn.mock.calls[0]![0])).toContain('address=48104');
	});

	// The never-throw contract. Distance sorting is a convenience; losing it
	// must never cost someone the turf list.
	it.each([
		['a non-200', () => Promise.resolve(res(500, ''))],
		['no matches', () => Promise.resolve(res(200, { result: { addressMatches: [] } }))],
		['a missing result envelope', () => Promise.resolve(res(200, {}))],
		[
			'non-numeric coordinates',
			() =>
				Promise.resolve(
					res(200, { result: { addressMatches: [{ coordinates: { x: 'a', y: 'b' } }] } }),
				),
		],
		[
			'null island',
			() =>
				Promise.resolve(
					res(200, { result: { addressMatches: [{ coordinates: { x: 0, y: 0 } }] } }),
				),
		],
		['a network failure', () => Promise.reject(new Error('ECONNRESET'))],
		[
			'a body that will not parse',
			() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: async () => {
						throw new Error('bad json');
					},
				} as unknown as Response),
		],
	])('returns null for %s rather than throwing', async (_label, impl) => {
		expect(await geocodeZip('48104', impl as never)).toBeNull();
	});
});

describe('lookupZipCentroid', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('returns a cached answer without calling the geocoder', async () => {
		const { db } = makeDb([{ zip: '48104', lat: 42.281, lng: -83.743 }]);
		const fetchFn = vi.fn();
		expect(await lookupZipCentroid(db, '48104', fetchFn as never)).toEqual({
			lat: 42.281,
			lng: -83.743,
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('geocodes and caches a ZIP it has not seen', async () => {
		const { db, written } = makeDb([]);
		const fetchFn = vi.fn().mockResolvedValue(res(200, MATCH));
		expect(await lookupZipCentroid(db, '48104', fetchFn as never)).toEqual({
			lat: 42.281,
			lng: -83.743,
		});
		expect(written).toHaveLength(1);
		expect(written[0]).toMatchObject({ zip: '48104', lat: 42.281, lng: -83.743 });
	});

	it('rejects a malformed ZIP without touching the network', async () => {
		const { db } = makeDb([]);
		const fetchFn = vi.fn();
		expect(await lookupZipCentroid(db, 'nope', fetchFn as never)).toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('still answers when the cache read fails', async () => {
		const { db } = makeDb([], { readThrows: true });
		const fetchFn = vi.fn().mockResolvedValue(res(200, MATCH));
		expect(await lookupZipCentroid(db, '48104', fetchFn as never)).not.toBeNull();
	});

	it('still answers when the cache write fails', async () => {
		// Having the answer and failing to store it beats failing the lookup.
		const { db } = makeDb([], { writeThrows: true });
		const fetchFn = vi.fn().mockResolvedValue(res(200, MATCH));
		expect(await lookupZipCentroid(db, '48104', fetchFn as never)).toEqual({
			lat: 42.281,
			lng: -83.743,
		});
	});

	it('returns null when the geocoder has no answer', async () => {
		const { db, written } = makeDb([]);
		const fetchFn = vi.fn().mockResolvedValue(res(200, { result: { addressMatches: [] } }));
		expect(await lookupZipCentroid(db, '48104', fetchFn as never)).toBeNull();
		expect(written).toHaveLength(0);
	});
});

// The /turfs Slack command lets a volunteer type a street address. Two rules
// hold everywhere below: the address is never written to a column, and it never
// appears in a log line.
const ADDRESS = '1600 Pennsylvania Ave NW, Washington DC';

const ADDRESS_MATCH = {
	result: {
		addressMatches: [
			{ coordinates: { x: -77.0365, y: 38.8977 }, addressComponents: { zip: '20500' } },
		],
	},
};

describe('geocodeAddress', () => {
	it('returns the point and the matched ZIP', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(200, ADDRESS_MATCH));
		await expect(geocodeAddress(ADDRESS, fetchFn as never)).resolves.toEqual({
			point: { lat: 38.8977, lng: -77.0365 },
			zip: '20500',
		});
	});

	it('sends the address to the one-line endpoint', async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(200, ADDRESS_MATCH));
		await geocodeAddress(ADDRESS, fetchFn as never);
		const url = new URL(fetchFn.mock.calls[0]![0] as string);
		expect(url.pathname).toContain('onelineaddress');
		expect(url.searchParams.get('address')).toBe(ADDRESS);
	});

	// The coordinates are still good without one, so this is not a failure — it
	// just means the chapter has to be resolved some other way.
	it('returns a null zip when the match carries no usable one', async () => {
		const body = {
			result: { addressMatches: [{ coordinates: { x: -77.03, y: 38.89 }, addressComponents: {} }] },
		};
		const fetchFn = vi.fn().mockResolvedValue(res(200, body));
		const out = await geocodeAddress(ADDRESS, fetchFn as never);
		expect(out?.point).toEqual({ lat: 38.89, lng: -77.03 });
		expect(out?.zip).toBeNull();
	});

	it.each([
		['no match', { result: { addressMatches: [] } }],
		['null island', { result: { addressMatches: [{ coordinates: { x: 0, y: 0 } }] } }],
		['junk coordinates', { result: { addressMatches: [{ coordinates: { x: 'x', y: 'y' } }] } }],
	])('returns null on %s', async (_label, body) => {
		const fetchFn = vi.fn().mockResolvedValue(res(200, body));
		await expect(geocodeAddress(ADDRESS, fetchFn as never)).resolves.toBeNull();
	});

	it.each([
		['an error status', () => Promise.resolve(res(500, {}))],
		['a timeout', () => Promise.reject(Object.assign(new Error('x'), { name: 'TimeoutError' }))],
	])('returns null rather than throwing on %s', async (_label, outcome) => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchFn = vi.fn().mockImplementation(outcome);
		await expect(geocodeAddress(ADDRESS, fetchFn as never)).resolves.toBeNull();
		warn.mockRestore();
	});

	it('does not call the geocoder for an empty query', async () => {
		const fetchFn = vi.fn();
		await expect(geocodeAddress('   ', fetchFn as never)).resolves.toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	// The rule that makes an address safe to accept at all. A warn line carrying
	// someone's home address outlives the request by however long the log
	// aggregator keeps it.
	it('never puts the address in a log line', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const outcomes = [
			() => Promise.resolve(res(500, {})),
			() => Promise.reject(new Error(`fetch failed for ${ADDRESS}`)),
		];
		for (const outcome of outcomes) {
			await geocodeAddress(ADDRESS, vi.fn().mockImplementation(outcome) as never);
		}
		const logged = warn.mock.calls.flat().join(' ');
		expect(logged).not.toContain('Pennsylvania');
		expect(logged).not.toContain(ADDRESS);
		warn.mockRestore();
	});
});

describe('resolveLocation', () => {
	it('takes the cached ZIP path for a bare ZIP', async () => {
		const { db } = makeDb([{ zip: '48104', lat: 42.28, lng: -83.74 }]);
		const fetchFn = vi.fn();
		await expect(resolveLocation(db, '48104', fetchFn as never)).resolves.toEqual({
			point: { lat: 42.28, lng: -83.74 },
			zip: '48104',
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('geocodes anything that is not a ZIP as an address', async () => {
		const { db } = makeDb();
		const fetchFn = vi.fn().mockResolvedValue(res(200, ADDRESS_MATCH));
		await expect(resolveLocation(db, ADDRESS, fetchFn as never)).resolves.toEqual({
			point: { lat: 38.8977, lng: -77.0365 },
			zip: '20500',
		});
	});

	// The whole data-handling posture in one assertion: an address goes in, and
	// only a ZIP centroid comes out the other side into a column.
	it('caches the matched ZIP and never the address', async () => {
		const { db, written } = makeDb();
		const fetchFn = vi.fn().mockResolvedValue(res(200, ADDRESS_MATCH));
		await resolveLocation(db, ADDRESS, fetchFn as never);
		expect(written).toEqual([
			{ zip: '20500', lat: 38.8977, lng: -77.0365, fetchedAt: expect.any(String) },
		]);
		expect(JSON.stringify(written)).not.toContain('Pennsylvania');
	});

	it('writes nothing when the match carries no ZIP', async () => {
		const { db, written } = makeDb();
		const body = {
			result: { addressMatches: [{ coordinates: { x: -77.03, y: 38.89 }, addressComponents: {} }] },
		};
		const fetchFn = vi.fn().mockResolvedValue(res(200, body));
		await resolveLocation(db, ADDRESS, fetchFn as never);
		expect(written).toEqual([]);
	});

	it.each([
		['null', null],
		['undefined', undefined],
		['blank', '   '],
	])('returns null for %s input without calling the geocoder', async (_label, raw) => {
		const { db } = makeDb();
		const fetchFn = vi.fn();
		await expect(resolveLocation(db, raw, fetchFn as never)).resolves.toBeNull();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('returns null when the address does not match', async () => {
		const { db } = makeDb();
		const fetchFn = vi.fn().mockResolvedValue(res(200, { result: { addressMatches: [] } }));
		await expect(resolveLocation(db, ADDRESS, fetchFn as never)).resolves.toBeNull();
	});

	it('survives a cache write failure', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { db } = makeDb([], { writeThrows: true });
		const fetchFn = vi.fn().mockResolvedValue(res(200, ADDRESS_MATCH));
		await expect(resolveLocation(db, ADDRESS, fetchFn as never)).resolves.toEqual({
			point: { lat: 38.8977, lng: -77.0365 },
			zip: '20500',
		});
		warn.mockRestore();
	});
});

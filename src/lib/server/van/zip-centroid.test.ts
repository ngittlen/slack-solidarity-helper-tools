import { describe, it, expect, vi, beforeEach } from 'vitest';
import { geocodeZip, lookupZipCentroid, normalizeZip } from './zip-centroid.js';

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

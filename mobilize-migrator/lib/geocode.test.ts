import { afterEach, describe, expect, it, vi } from 'vitest';

import { lookupPostalCode, parseCoordinates, pointKey } from './geocode.js';

/** The shape the Census geocoder actually answers with, trimmed to what matters. */
function censusBody(zip: string | null) {
	return {
		result: {
			geographies: {
				'Census Blocks': [{ GEOID: '260495101001000' }],
				'Zip Code Tabulation Areas': zip ? [{ BASENAME: zip, ZCTA5: zip }] : [],
			},
		},
	};
}

/** Returns the URLs the code under test requested. */
function stubFetch(body: unknown, ok = true): string[] {
	const requested: string[] = [];
	vi.stubGlobal('fetch', async (url: unknown) => {
		requested.push(String(url));
		return { ok, status: ok ? 200 : 500, json: async () => body };
	});
	return requested;
}

describe('parseCoordinates', () => {
	it('reads the JSON-encoded string Solidarity stores', () => {
		expect(parseCoordinates('{"lat":42.9837207,"lng":-83.6748673}')).toEqual({
			lat: 42.9837207,
			lng: -83.6748673,
		});
	});

	it('rejects null island, which is a missing location rather than a place', () => {
		expect(parseCoordinates('{"lat":0,"lng":0}')).toBeNull();
	});

	it('survives absent or malformed values', () => {
		expect(parseCoordinates(null)).toBeNull();
		expect(parseCoordinates('')).toBeNull();
		expect(parseCoordinates('not json')).toBeNull();
		expect(parseCoordinates('{"lat":"x","lng":1}')).toBeNull();
	});
});

describe('pointKey', () => {
	it('is stable for the identical coordinates repeated across sessions', () => {
		expect(pointKey({ lat: 42.9837207, lng: -83.6748673 })).toBe('42.98372,-83.67487');
		expect(pointKey({ lat: 42.98372071, lng: -83.6748673 })).toBe('42.98372,-83.67487');
	});
});

describe('lookupPostalCode', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns the ZCTA for a point', async () => {
		const requested = stubFetch(censusBody('48507'));
		expect(await lookupPostalCode({ lat: 42.9837207, lng: -83.6748673 })).toBe('48507');

		// x is longitude and y is latitude — swapping them lands in the ocean and
		// silently yields no zip, so it is worth pinning.
		const url = new URL(requested[0]);
		expect(url.searchParams.get('x')).toBe('-83.6748673');
		expect(url.searchParams.get('y')).toBe('42.9837207');
	});

	it('returns null when the point is in no ZCTA', async () => {
		stubFetch(censusBody(null));
		expect(await lookupPostalCode({ lat: 45, lng: -87 })).toBeNull();
	});

	it('returns null rather than throwing when the geocoder is down', async () => {
		// One external service being unavailable must not fail the whole sync.
		vi.stubGlobal('fetch', async () => {
			throw new Error('ECONNREFUSED');
		});
		expect(await lookupPostalCode({ lat: 42.3, lng: -83.4 })).toBeNull();

		stubFetch({ result: {} }, false);
		expect(await lookupPostalCode({ lat: 42.3, lng: -83.4 })).toBeNull();
	});

	it('rejects anything that is not a five-digit zip', async () => {
		stubFetch(censusBody('4850'));
		expect(await lookupPostalCode({ lat: 42.3, lng: -83.4 })).toBeNull();
	});
});

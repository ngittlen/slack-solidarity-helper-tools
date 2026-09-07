import { describe, it, expect, vi } from 'vitest';
import {
	geocodeAddresses,
	parseBatchResponse,
	MAX_BATCH,
	MAX_BATCHES,
	type AddressLookup,
} from './geocode-batch.js';

/** A real response line, copied from a live call to the Census batch endpoint.
 *  Note the coordinate pair is longitude first, and the echoed input address
 *  contains commas — both of which break a naive parser. */
const LIVE_MATCH =
	'"1","400 S Orange Ave, Orlando, FL, 32801","Match","Exact",' +
	'"400 S ORANGE AVE, ORLANDO, FL, 32801","-81.378959459636,28.538315364222","94282478","R"';
const LIVE_NO_MATCH = '"2","999 Nowhere Rd, Orlando, FL, 32801","No_Match"';

function lookup(over: Partial<AddressLookup> = {}): AddressLookup {
	return {
		id: '1',
		street: '400 S Orange Ave',
		city: 'Orlando',
		state: 'FL',
		zip: '32801',
		...over,
	};
}

describe('parseBatchResponse', () => {
	// Longitude first is the single most dangerous detail in this file: swap
	// them and turf plots in the Indian Ocean with no error anywhere.
	it('reads a match as lat/lng, not lng/lat', () => {
		const found = parseBatchResponse(LIVE_MATCH);
		expect(found.get('1')).toEqual({ lat: 28.538315364222, lng: -81.378959459636 });
	});

	it('skips a no-match rather than inventing a coordinate', () => {
		const found = parseBatchResponse(`${LIVE_MATCH}\n${LIVE_NO_MATCH}`);
		expect(found.has('1')).toBe(true);
		expect(found.has('2')).toBe(false);
		expect(found.size).toBe(1);
	});

	it('rejects null island and out-of-range coordinates', () => {
		const body = [
			'"1","x","Match","Exact","x","0,0","1","L"',
			'"2","x","Match","Exact","x","-81.3,91.5","1","L"',
			'"3","x","Match","Exact","x","181.2,28.5","1","L"',
		].join('\n');
		expect(parseBatchResponse(body).size).toBe(0);
	});

	it('tolerates blank lines and a malformed row', () => {
		const found = parseBatchResponse(`\n${LIVE_MATCH}\n\ngarbage\n`);
		expect(found.size).toBe(1);
	});

	it('returns an empty map for an empty body', () => {
		expect(parseBatchResponse('').size).toBe(0);
	});
});

describe('geocodeAddresses', () => {
	function okResponse(body: string) {
		return vi.fn(async () => new Response(body, { status: 200 }));
	}

	it('posts a CSV with no header row and the benchmark', async () => {
		const fetchFn = okResponse(LIVE_MATCH);
		await geocodeAddresses([lookup()], fetchFn as never);

		const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
		expect(url).toContain('geocoding.geo.census.gov');
		expect(init.method).toBe('POST');

		const form = init.body as FormData;
		expect(form.get('benchmark')).toBe('Public_AR_Current');
		const csv = await (form.get('addressFile') as Blob).text();
		expect(csv).toBe('1,400 S Orange Ave,Orlando,FL,32801');
	});

	// The privacy contract: the file handed to Census carries address
	// components and a synthetic row id, and nothing else. A regression here is
	// a disclosure, not a bug, so it is asserted on the exact bytes sent.
	it('sends only address components — never a name, DOB, party or VanID', async () => {
		const fetchFn = okResponse('');
		await geocodeAddresses([lookup()], fetchFn as never);

		const form = (fetchFn.mock.calls[0]! as unknown as [string, RequestInit])[1].body as FormData;
		const csv = await (form.get('addressFile') as Blob).text();
		for (const forbidden of ['Campbell', 'Ron', '1968', 'Democrat', '568504', '@']) {
			expect(csv).not.toContain(forbidden);
		}
		// Five fields exactly: id, street, city, state, zip.
		expect(csv.split(',')).toHaveLength(5);
	});

	it('quotes a street containing a comma', async () => {
		const fetchFn = okResponse('');
		await geocodeAddresses([lookup({ street: '12 Main St, Apt 4' })], fetchFn as never);
		const form = (fetchFn.mock.calls[0]! as unknown as [string, RequestInit])[1].body as FormData;
		expect(await (form.get('addressFile') as Blob).text()).toContain('"12 Main St, Apt 4"');
	});

	it('chunks a large set into several requests', async () => {
		const fetchFn = okResponse('');
		const rows = Array.from({ length: MAX_BATCH + 5 }, (_, i) => lookup({ id: String(i) }));
		await geocodeAddresses(rows, fetchFn as never);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('caps the total rather than geocoding an unbounded list', async () => {
		const fetchFn = okResponse('');
		const rows = Array.from({ length: MAX_BATCH * (MAX_BATCHES + 3) }, (_, i) =>
			lookup({ id: String(i) }),
		);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await geocodeAddresses(rows, fetchFn as never);
		expect(fetchFn).toHaveBeenCalledTimes(MAX_BATCHES);
		vi.restoreAllMocks();
	});

	// Matching zip-centroid.ts: a geocoder outage means a turf renders as a
	// pin, never a failed sync.
	it('never throws on an HTTP error', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchFn = vi.fn(async () => new Response('nope', { status: 503 }));
		await expect(geocodeAddresses([lookup()], fetchFn as never)).resolves.toEqual(new Map());
		// Counts and status only — the warn line must not carry an address.
		expect(String(warn.mock.calls[0]?.[0] ?? '')).not.toContain('Orange Ave');
		warn.mockRestore();
	});

	it('never throws on a network failure', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchFn = vi.fn(async () => {
			throw new Error('ECONNRESET');
		});
		await expect(geocodeAddresses([lookup()], fetchFn as never)).resolves.toEqual(new Map());
		expect(String(warn.mock.calls[0]?.[0] ?? '')).not.toContain('Orange Ave');
		warn.mockRestore();
	});

	it('makes no request at all for an empty list', async () => {
		const fetchFn = okResponse('');
		expect(await geocodeAddresses([], fetchFn as never)).toEqual(new Map());
		expect(fetchFn).not.toHaveBeenCalled();
	});

	// MAX_BATCHES requests at the per-request timeout is five minutes for ONE
	// turf — longer than the whole request the scheduled sync is allowed. The
	// caller's deadline has to reach in here, or it bounds nothing.
	describe('the caller deadline', () => {
		const manyRows = () =>
			Array.from({ length: MAX_BATCH * 3 }, (_, i) => lookup({ id: String(i) }));

		it('starts no batch at all once it has passed', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const fetchFn = okResponse('');
			const found = await geocodeAddresses(manyRows(), fetchFn as never, {
				deadline: Date.now() - 1,
			});

			expect(fetchFn).not.toHaveBeenCalled();
			// A miss, not a failure: the hull is built from what VAN had.
			expect(found).toEqual(new Map());
			expect(String(warn.mock.calls[0]?.[0] ?? '')).not.toContain('Orange Ave');
			warn.mockRestore();
		});

		// The overrun is cumulative — three batches of a minute each is the
		// failure, not any one of them — so the check has to be inside the loop.
		// A getter stands in for time passing during the first request, which
		// keeps the test instant instead of sleeping through a real budget.
		it('stops between batches rather than only checking at the start', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			let deadline = Date.now() + 60_000;
			const fetchFn = vi.fn(async () => {
				deadline = Date.now() - 1;
				return new Response('', { status: 200 });
			});
			await geocodeAddresses(manyRows(), fetchFn as never, {
				get deadline() {
					return deadline;
				},
			});

			// Three batches of rows, one request: the rest were abandoned.
			expect(fetchFn).toHaveBeenCalledOnce();
			warn.mockRestore();
		});

		// A request aborted at three seconds costs the same latency as one that
		// succeeds and returns nothing, so a sliver of budget is not spent.
		it('declines a batch there is not enough time left to finish', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const roomy = vi.fn(async () => new Response('', { status: 200 }));
			await geocodeAddresses([lookup()], roomy as never, { deadline: Date.now() + 30_000 });
			expect(roomy).toHaveBeenCalledOnce();

			const cramped = vi.fn(async () => new Response('', { status: 200 }));
			await geocodeAddresses([lookup()], cramped as never, { deadline: Date.now() + 1_000 });
			expect(cramped).not.toHaveBeenCalled();
			warn.mockRestore();
		});

		it('is unbounded when no deadline is given, as scripts/ calls it', async () => {
			const fetchFn = okResponse('');
			await geocodeAddresses([lookup()], fetchFn as never);
			expect(fetchFn).toHaveBeenCalledOnce();
		});
	});
});

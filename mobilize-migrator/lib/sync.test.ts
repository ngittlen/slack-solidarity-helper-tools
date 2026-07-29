import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MobilizeApiConfig, MobilizeEvent } from './mobilize.js';
import { describeChanges, reconcileTimeslots, runSync, type Ledger } from './sync.js';
import type { EventContact } from './payload.js';
import type { PlannedEvent } from './transform.js';

const HOUR = 3600_000;
const START = Date.parse('2026-08-01T22:00:00Z'); // 18:00 America/New_York
// Pinned so the past/upcoming split in reconcileTimeslots doesn't depend on the
// wall clock the suite happens to run at.
const NOW = START - 7 * 24 * HOUR;

function plan(overrides: Partial<PlannedEvent> = {}): PlannedEvent {
	const starts = [START];
	return {
		key: 'solidarity:1:venue',
		solidarityEventId: 1,
		solidaritySessionIds: [10],
		title: 'Detroit Canvass',
		description: 'Knock doors',
		eventType: 'COMMUNITY_CANVASS',
		locationName: 'Field Office',
		addressLine1: '2857 East Grand Boulevard',
		city: 'Detroit',
		state: 'MI',
		zipcode: '48202',
		country: 'US',
		locationIsPrivate: false,
		coordinates: { lat: 42.3806, lng: -83.0658 },
		timeslots: starts.map((s) => ({
			startDate: Math.floor(s / 1000),
			endDate: Math.floor((s + 2 * HOUR) / 1000),
			maxAttendees: null,
		})),
		startInstants: starts,
		endInstants: starts.map((s) => s + 2 * HOUR),
		sourceUrl: null,
		sourceImageUrl: null,
		...overrides,
	};
}

function live(
	slots: { id: number; start: number; end?: number }[],
	overrides: Partial<MobilizeEvent> = {},
): MobilizeEvent {
	return {
		id: 900,
		title: 'Detroit Canvass',
		event_type: 'COMMUNITY_CANVASS',
		description: 'Knock doors',
		timeslots: slots.map((s) => ({
			id: s.id,
			start_date: Math.floor(s.start / 1000),
			end_date: Math.floor((s.end ?? s.start + 2 * HOUR) / 1000),
		})),
		location: { locality: 'Detroit', postal_code: '48202' },
		...overrides,
	};
}

describe('reconcileTimeslots', () => {
	it('reuses the existing id when the shift is unchanged', () => {
		const result = reconcileTimeslots(plan(), live([{ id: 5001, start: START }]), NOW);
		expect(result.timeslots).toEqual([
			{
				id: 5001,
				startDate: Math.floor(START / 1000),
				endDate: Math.floor((START + 2 * HOUR) / 1000),
				maxAttendees: null,
			},
		]);
		expect(result.changed).toBe(false);
		expect(result.orphanCount).toBe(0);
	});

	it('sends a genuinely new session without an id so Mobilize creates it', () => {
		const twoSlots = plan({
			timeslots: [
				{
					startDate: Math.floor(START / 1000),
					endDate: Math.floor((START + 2 * HOUR) / 1000),
					maxAttendees: null,
				},
				{
					startDate: Math.floor((START + 24 * HOUR) / 1000),
					endDate: Math.floor((START + 26 * HOUR) / 1000),
					maxAttendees: null,
				},
			],
			startInstants: [START, START + 24 * HOUR],
			endInstants: [START + 2 * HOUR, START + 26 * HOUR],
		});
		const result = reconcileTimeslots(twoSlots, live([{ id: 5001, start: START }]), NOW);
		expect(result.timeslots[0].id).toBe(5001);
		expect(result.timeslots[1].id).toBeUndefined();
		expect(result.changed).toBe(true);
	});

	it('KEEPS an upcoming shift that has no counterpart, rather than deleting its signups', () => {
		// A session cancelled in Solidarity. Omitting it from the PUT would
		// destroy the shift and its RSVPs.
		const result = reconcileTimeslots(
			plan(),
			live([
				{ id: 5001, start: START },
				{ id: 4000, start: START + 72 * HOUR },
			]),
			NOW,
		);
		expect(result.timeslots.map((s) => s.id)).toEqual([5001, 4000]);
		expect(result.orphanCount).toBe(1);
	});

	it('drops a PAST orphan instead of re-sending it', () => {
		// The v1 endpoint does not modify past timeslots, so sending them is at
		// best noise. Omitting them is safe precisely because it cannot delete
		// them either.
		const result = reconcileTimeslots(
			plan(),
			live([
				{ id: 5001, start: START },
				{ id: 4000, start: NOW - 72 * HOUR },
			]),
			NOW,
		);
		expect(result.timeslots.map((s) => s.id)).toEqual([5001]);
		expect(result.orphanCount).toBe(0);
	});

	it('matches within a minute of tolerance', () => {
		const result = reconcileTimeslots(plan(), live([{ id: 5001, start: START + 30_000 }]), NOW);
		expect(result.timeslots[0].id).toBe(5001);
		expect(result.changed).toBe(false);
	});

	it('treats a moved start time as a new shift, keeping the old one', () => {
		const result = reconcileTimeslots(plan(), live([{ id: 5001, start: START + 3 * HOUR }]), NOW);
		expect(result.timeslots[0].id).toBeUndefined();
		expect(result.timeslots[1].id).toBe(5001);
		expect(result.changed).toBe(true);
	});

	it('detects an end-time change even when the start still matches', () => {
		const result = reconcileTimeslots(
			plan(),
			live([{ id: 5001, start: START, end: START + 5 * HOUR }]),
			NOW,
		);
		expect(result.timeslots[0].id).toBe(5001);
		expect(result.changed).toBe(true);
	});

	it('does not reuse one live shift for two planned shifts', () => {
		const duplicate = plan({
			timeslots: [
				{
					startDate: Math.floor(START / 1000),
					endDate: Math.floor((START + 2 * HOUR) / 1000),
					maxAttendees: null,
				},
				{
					startDate: Math.floor(START / 1000),
					endDate: Math.floor((START + 2 * HOUR) / 1000),
					maxAttendees: null,
				},
			],
			startInstants: [START, START],
			endInstants: [START + 2 * HOUR, START + 2 * HOUR],
		});
		const result = reconcileTimeslots(duplicate, live([{ id: 5001, start: START }]), NOW);
		expect(result.timeslots[0].id).toBe(5001);
		expect(result.timeslots[1].id).toBeUndefined();
	});
});

describe('describeChanges', () => {
	it('reports nothing when everything matches', () => {
		expect(describeChanges(plan(), live([{ id: 1, start: START }]), false, false)).toEqual([]);
	});

	it('detects title and description edits', () => {
		const changed = live([{ id: 1, start: START }], {
			title: 'Old title',
			description: 'Old body',
		});
		expect(describeChanges(plan(), changed, false, false)).toEqual(['title', 'description']);
	});

	it('flags a missing image only when the source has one', () => {
		const noImage = live([{ id: 1, start: START }], { featured_image_url: null });
		expect(describeChanges(plan(), noImage, true, false)).toEqual(['image']);
		expect(describeChanges(plan(), noImage, false, false)).toEqual([]);
	});

	it('does not re-upload when Mobilize already has an image', () => {
		const withImage = live([{ id: 1, start: START }], {
			featured_image_url: 'https://mobilizeamerica.imgix.net/x.png',
		});
		expect(describeChanges(plan(), withImage, true, false)).toEqual([]);
	});

	it('ignores whitespace-only differences', () => {
		const padded = live([{ id: 1, start: START }], {
			title: '  Detroit Canvass  ',
			description: 'Knock doors\n',
		});
		expect(describeChanges(plan(), padded, false, false)).toEqual([]);
	});

	it('detects a city change', () => {
		const moved = live([{ id: 1, start: START }], {
			location: { locality: 'Ypsilanti', postal_code: '48202' },
		});
		expect(describeChanges(plan(), moved, false, false)).toEqual(['location']);
	});

	it('backfills a postal code onto an event migrated without one', () => {
		// Everything created before the v1 switch went in with no zip — the old
		// dashboard API accepted that, and v1 will not.
		const noZip = live([{ id: 1, start: START }], { location: { locality: 'Detroit' } });
		expect(describeChanges(plan(), noZip, false, false)).toEqual(['postal code']);
	});

	it('does not ask for an update when we have no zip to offer either', () => {
		const noZip = live([{ id: 1, start: START }], { location: { locality: 'Detroit' } });
		expect(describeChanges(plan({ zipcode: '' }), noZip, false, false)).toEqual([]);
	});
});

describe('runSync dry run', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 1 };
	const CONTACT: EventContact = {
		name: 'Field Team',
		emailAddress: 'field@example.org',
		phoneNumber: '',
	};

	/** Records every ledger write so the test can assert there were none. */
	function spyLedger(known: { key: string; mobilizeEventId: number; title: string }[]) {
		const writes: string[] = [];
		const ledger: Ledger = {
			async all() {
				return known;
			},
			async record() {
				writes.push('record');
			},
			async imageFor() {
				return null;
			},
			async recordImage() {
				writes.push('recordImage');
			},
			async zipFor() {
				return null;
			},
			async recordZip() {
				writes.push('recordZip');
			},
			async recordTimeslots() {
				writes.push('recordTimeslots');
			},
		};
		return { ledger, writes };
	}

	it('writes nothing to the ledger, not even timeslot pairings', async () => {
		// Regression: recordTimeslots sat outside the apply branch, so a dry run
		// persisted pairings — on the server, straight into production Turso.
		const planned = plan();
		// The client reads the body with text() and parses it itself, so the stub
		// has to return a real JSON string rather than a json() shortcut.
		const body = JSON.stringify({
			data: [
				{
					id: 900,
					title: planned.title,
					event_type: 'COMMUNITY_CANVASS',
					description: 'different, so an update is warranted',
					timeslots: [{ id: 5001, start_date: Math.floor(START / 1000), end_date: 0 }],
					location: { locality: 'Detroit' },
				},
			],
			next: null,
		});
		vi.stubGlobal('fetch', async () => ({
			ok: true,
			status: 200,
			text: async () => body,
			headers: new Headers(),
		}));

		const { ledger, writes } = spyLedger([
			{ key: planned.key, mobilizeEventId: 900, title: planned.title },
		]);

		const report = await runSync(
			[planned],
			{
				api: API,
				contact: CONTACT,
				maxCreatesPerRun: 100,
				apply: false,
				pauseMs: 0,
			},
			ledger,
			() => null,
		);

		expect(report.updated).toBe(1);
		expect(writes).toEqual([]);
	});
});

describe('runSync postal codes', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 1 };
	const CONTACT: EventContact = {
		name: 'Field Team',
		emailAddress: 'field@example.org',
		phoneNumber: '',
	};

	/**
	 * Both services on one stub, routed by URL: the Mobilize client reads its
	 * responses with text(), the Census geocoder with json().
	 */
	function stubApis(zip: string | null) {
		const calls: { url: string; method: string; body: unknown }[] = [];
		vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
			const url = String(input);
			calls.push({
				url,
				method: init.method ?? 'GET',
				body: init.body ? JSON.parse(String(init.body)) : null,
			});
			if (url.includes('census.gov')) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						result: {
							geographies: {
								'Zip Code Tabulation Areas': zip ? [{ ZCTA5: zip, BASENAME: zip }] : [],
							},
						},
					}),
				};
			}
			const body =
				init.method === 'POST'
					? JSON.stringify({
							data: { event: { id: 901, title: 'Detroit Canvass', timeslots: [] } },
						})
					: JSON.stringify({ data: [], next: null });
			return { ok: true, status: 200, text: async () => body, headers: new Headers() };
		});
		return calls;
	}

	function ledgerWith(zips: Record<string, string> = {}) {
		const recorded: Record<string, string> = {};
		const ledger: Ledger = {
			async all() {
				return [];
			},
			async record() {},
			async imageFor() {
				return null;
			},
			async recordImage() {},
			async zipFor(point) {
				return zips[point] ?? null;
			},
			async recordZip(point, postalCode) {
				recorded[point] = postalCode;
			},
		};
		return { ledger, recorded };
	}

	const run = (planned: PlannedEvent, ledger: Ledger, apply = true) =>
		runSync(
			[planned],
			{ api: API, contact: CONTACT, maxCreatesPerRun: 100, apply, pauseMs: 0 },
			ledger,
			() => null,
		);

	it('geocodes a missing postal code and sends it, because Mobilize requires one', async () => {
		const calls = stubApis('48507');
		const { ledger, recorded } = ledgerWith();

		const report = await run(
			plan({ zipcode: '', coordinates: { lat: 42.9837207, lng: -83.6748673 } }),
			ledger,
		);

		expect(report.created).toBe(1);
		expect(report.failed).toBe(0);
		const create = calls.find((c) => c.method === 'POST')!;
		expect((create.body as { location: { postal_code: string } }).location.postal_code).toBe(
			'48507',
		);
		// Cached by point, so the same venue is not looked up again tomorrow.
		expect(recorded).toEqual({ '42.98372,-83.67487': '48507' });
	});

	it('reuses a cached zip instead of calling the geocoder', async () => {
		const calls = stubApis(null);
		const { ledger } = ledgerWith({ '42.98372,-83.67487': '48507' });

		const report = await run(
			plan({ zipcode: '', coordinates: { lat: 42.9837207, lng: -83.6748673 } }),
			ledger,
		);

		expect(report.created).toBe(1);
		expect(calls.some((c) => c.url.includes('census.gov'))).toBe(false);
	});

	it('reports the event instead of sending a create Mobilize will reject', async () => {
		// A blank postal_code is a 400 every night; saying so once is more useful.
		const calls = stubApis(null);
		const { ledger } = ledgerWith();

		const report = await run(plan({ zipcode: '', coordinates: null }), ledger);

		expect(report.created).toBe(0);
		expect(report.failed).toBe(1);
		expect(report.errors[0]).toMatch(/no postal code/);
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
	});

	it('does not cache a lookup made during a dry run', async () => {
		stubApis('48507');
		const { ledger, recorded } = ledgerWith();

		const report = await run(
			plan({ zipcode: '', coordinates: { lat: 42.9837207, lng: -83.6748673 } }),
			ledger,
			false,
		);

		expect(report.created).toBe(1);
		expect(recorded).toEqual({});
	});
});

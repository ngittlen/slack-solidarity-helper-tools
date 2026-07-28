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
		location: { locality: 'Detroit' },
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
		const moved = live([{ id: 1, start: START }], { location: { locality: 'Ypsilanti' } });
		expect(describeChanges(plan(), moved, false, false)).toEqual(['location']);
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

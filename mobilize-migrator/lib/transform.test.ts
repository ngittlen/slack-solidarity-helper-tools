import { describe, expect, it } from 'vitest';

import { findDuplicate, normalizeTitle, titleSimilarity } from './dedupe.js';
import type { MobilizeEvent } from './mobilize.js';
import { classifyEventType, planMigration } from './transform.js';
import type { SolidarityEvent } from './solidarity.js';
import { EVENT_TYPE } from './payload.js';

const NOW = Date.parse('2026-07-26T00:00:00Z');

function session(overrides: Partial<SolidarityEvent['event_sessions'][number]> = {}) {
	return {
		id: 1,
		title: 'Session',
		start_time: '2026-07-30T20:00:00.000-04:00',
		end_time: '2026-07-30T22:00:00.000-04:00',
		location_name: 'Venue',
		location_address: '100 N Main St, Ann Arbor, MI 48104, USA',
		location_data: {
			full_address: '100 N Main St, Ann Arbor, MI 48104, USA',
			address_line_1: '100 North Main Street',
			address_city: 'Ann Arbor',
			address_state: 'MI',
			address_postal_code: '48104',
			address_country: 'US',
			coordinates: '{"lat":42.2814215,"lng":-83.7485052}',
		},
		max_capacity: null,
		event_type: 'in_person',
		...overrides,
	};
}

function event(overrides: Partial<SolidarityEvent> = {}): SolidarityEvent {
	return {
		id: 100,
		title: 'Ann Arbor Canvass',
		event_type: 'in_person',
		scope_id: 376,
		scope_type: 'Organization',
		description: 'Come knock doors',
		// Both must be present in the base literal, not just in the interface:
		// a property supplied only by the Partial spread is typed `| undefined`,
		// which the SolidarityEvent return type rejects.
		event_page_id: null,
		event_page_url: null,
		image_url: null,
		hide_address_until_rsvp: false,
		is_co_hosted_mirror: false,
		primary_event_id: 100,
		event_sessions: [session()],
		...overrides,
	};
}

describe('timeslot instants', () => {
	it('resolves the same instant identically regardless of the offset Solidarity used', () => {
		// Solidarity returned this one session both ways across two calls. Unix
		// timestamps make the inconsistent offset a non-issue: only the instant
		// matters, and all three of these are the same instant.
		const at = (start: string) =>
			planMigration(
				[event({ event_sessions: [session({ start_time: start, end_time: start })] })],
				NOW,
			).planned[0].timeslots[0].startDate;
		expect(at('2026-07-30T20:00:00.000-04:00')).toBe(at('2026-07-30T18:00:00.000-06:00'));
		expect(at('2026-07-30T20:00:00.000-04:00')).toBe(at('2026-07-31T00:00:00.000Z'));
	});
});

describe('classifyEventType', () => {
	it('treats canvasses and door knocking as COMMUNITY_CANVASS', () => {
		expect(classifyEventType('Saginaw Canvass for Abdul', '')).toBe(EVENT_TYPE.COMMUNITY_CANVASS);
		expect(classifyEventType('Knock Out the Vote Tour', '')).toBe(EVENT_TYPE.COMMUNITY_CANVASS);
	});

	it('leaves everything else as COMMUNITY', () => {
		expect(classifyEventType('Pontiac Debate Watch Party', '')).toBe(EVENT_TYPE.COMMUNITY);
		expect(classifyEventType('Abdul Rocks: Detroit Concert', '')).toBe(EVENT_TYPE.COMMUNITY);
	});
});

describe('planMigration', () => {
	it('splits one multi-city event into one Mobilize event per location', () => {
		const flint = session({
			id: 1,
			title: 'Operation GOTV: Flint',
			location_address: '4400 S Saginaw St, Flint, MI 48507, USA',
			location_data: {
				full_address: '4400 S Saginaw St, Flint, MI 48507, USA',
				address_line_1: '4400 South Saginaw Street',
				address_city: 'Flint',
				address_state: 'MI',
				address_postal_code: '48507',
				address_country: 'US',
				coordinates: '{"lat":42.98,"lng":-83.67}',
			},
		});
		const detroit = session({
			id: 2,
			title: 'Operation GOTV: Detroit',
			location_address: '2857 E Grand Blvd, Detroit, MI 48202, USA',
			location_data: {
				full_address: '2857 E Grand Blvd, Detroit, MI 48202, USA',
				address_line_1: '2857 East Grand Boulevard',
				address_city: 'Detroit',
				address_state: 'MI',
				address_postal_code: '48202',
				address_country: 'US',
				coordinates: '{"lat":42.37,"lng":-83.06}',
			},
		});

		const { planned } = planMigration(
			[event({ title: 'Operation GOTV', event_sessions: [flint, detroit] })],
			NOW,
		);

		expect(planned).toHaveLength(2);
		expect(planned.map((p) => p.city).sort()).toEqual(['Detroit', 'Flint']);
		// Distinct titles, so the two don't look identical in the Mobilize feed.
		expect(new Set(planned.map((p) => p.title)).size).toBe(2);
	});

	it('collapses many sessions at one venue into a single event with many timeslots', () => {
		const sessions = [
			session({ id: 1, start_time: '2026-07-28T21:30:00Z', end_time: '2026-07-29T00:00:00Z' }),
			session({ id: 2, start_time: '2026-07-29T19:00:00Z', end_time: '2026-07-29T21:30:00Z' }),
			session({ id: 3, start_time: '2026-07-31T21:30:00Z', end_time: '2026-08-01T00:00:00Z' }),
		];
		const { planned } = planMigration([event({ event_sessions: sessions })], NOW);

		expect(planned).toHaveLength(1);
		expect(planned[0].timeslots).toHaveLength(3);
		// Sorted chronologically.
		expect(planned[0].timeslots.map((t) => t.startDate)).toEqual([
			Date.parse('2026-07-28T21:30:00Z') / 1000,
			Date.parse('2026-07-29T19:00:00Z') / 1000,
			Date.parse('2026-07-31T21:30:00Z') / 1000,
		]);
	});

	it('drops past sessions but keeps the event for its future ones', () => {
		const { planned } = planMigration(
			[
				event({
					event_sessions: [
						session({
							id: 1,
							start_time: '2026-07-01T20:00:00Z',
							end_time: '2026-07-01T22:00:00Z',
						}),
						session({ id: 2 }),
					],
				}),
			],
			NOW,
		);
		expect(planned).toHaveLength(1);
		expect(planned[0].solidaritySessionIds).toEqual([2]);
	});

	it('skips virtual events and co-hosted mirrors', () => {
		const { planned } = planMigration(
			[event({ event_type: 'virtual' }), event({ id: 101, is_co_hosted_mirror: true })],
			NOW,
		);
		expect(planned).toHaveLength(0);
	});

	it('reports events with no usable address instead of inventing one', () => {
		const { planned, skipped } = planMigration(
			[event({ event_sessions: [session({ location_data: null, location_address: null })] })],
			NOW,
		);
		expect(planned).toHaveLength(0);
		expect(skipped).toHaveLength(1);
		expect(skipped[0].reason).toMatch(/no usable address/);
	});

	it('falls back to parsing location_address when the structured fields are blank', () => {
		// The common real shape: coordinates only, address in the display string.
		const { planned } = planMigration(
			[
				event({
					event_sessions: [
						session({
							location_name: 'Office Inside Insight',
							location_address: '4400 South Saginaw Street, Flint, MI, USA',
							location_data: { coordinates: '{"lat":42.9837207,"lng":-83.6748673}' },
						}),
					],
				}),
			],
			NOW,
		);
		expect(planned).toHaveLength(1);
		expect(planned[0]).toMatchObject({
			addressLine1: '4400 South Saginaw Street',
			city: 'Flint',
			state: 'MI',
			locationName: 'Office Inside Insight',
		});
	});

	it('skips a city-only address rather than dropping a pin on the city centroid', () => {
		const { planned, skipped } = planMigration(
			[
				event({
					event_sessions: [
						session({
							location_address: 'Ann Arbor, MI, USA',
							location_data: { coordinates: '{"lat":42.28,"lng":-83.74}' },
						}),
					],
				}),
			],
			NOW,
		);
		expect(planned).toHaveLength(0);
		expect(skipped).toHaveLength(1);
	});

	it('converts a zero capacity to unlimited rather than zero seats', () => {
		const { planned } = planMigration(
			[event({ event_sessions: [session({ max_capacity: 0 })] })],
			NOW,
		);
		expect(planned[0].timeslots[0].maxAttendees).toBeNull();
	});

	it('keeps a real capacity', () => {
		const { planned } = planMigration(
			[event({ event_sessions: [session({ max_capacity: 12 })] })],
			NOW,
		);
		expect(planned[0].timeslots[0].maxAttendees).toBe(12);
	});
});

describe('duplicate detection', () => {
	const planned = planMigration([event()], NOW).planned[0];

	function mobilizeEvent(overrides: Partial<MobilizeEvent> = {}): MobilizeEvent {
		return {
			id: 999,
			title: 'Ann Arbor Canvass',
			event_type: 'COMMUNITY_CANVASS',
			timeslots: [{ id: 1, start_date: Date.parse('2026-07-31T00:00:00Z') / 1000, end_date: 0 }],
			location: { locality: 'Ann Arbor' },
			...overrides,
		};
	}

	it('matches an identical title', () => {
		expect(findDuplicate(planned, [mobilizeEvent()])?.reason).toBe('identical title');
	});

	it('matches a reworded title at the same start time', () => {
		// Real pair: Solidarity vs Mobilize naming of the Negaunee event.
		const match = findDuplicate(planned, [
			mobilizeEvent({ title: 'Ann Arbor Canvass Launch with Max Frost' }),
		]);
		expect(match).not.toBeNull();
	});

	it('does not match the same generic event in a different city', () => {
		// Real case: watch parties in Coldwater, Lansing, Pontiac and Oakland all
		// started at 7:15pm. Title overlap alone made them duplicates of each other.
		const coldwater = planMigration(
			[
				event({
					title: 'Coldwater 7/27 Debate Watch Party',
					event_sessions: [
						session({
							location_data: {
								full_address: '1 Main St, Coldwater, MI 49036, USA',
								address_line_1: '1 Main St',
								address_city: 'Coldwater',
								address_state: 'MI',
								address_postal_code: '49036',
								address_country: 'US',
								coordinates: '{"lat":41.94,"lng":-85.0}',
							},
						}),
					],
				}),
			],
			NOW,
		).planned[0];

		expect(
			findDuplicate(coldwater, [
				mobilizeEvent({ title: 'Oakland Debate Watch Party', location: { locality: 'Pontiac' } }),
			]),
		).toBeNull();
	});

	it('still matches when one city is a longer form of the other', () => {
		expect(
			findDuplicate(planned, [
				mobilizeEvent({
					title: 'Ann Arbor Canvass Launch',
					location: { locality: 'Ann Arbor Township' },
				}),
			]),
		).not.toBeNull();
	});

	it('matches on identical title even when the cities differ', () => {
		expect(
			findDuplicate(planned, [
				mobilizeEvent({ title: 'Ann Arbor Canvass', location: { locality: 'Ypsilanti' } }),
			])?.reason,
		).toBe('identical title');
	});

	it('does not match an unrelated event that merely starts at the same time', () => {
		expect(
			findDuplicate(planned, [
				mobilizeEvent({ title: 'Bay City Concert', location: { locality: 'Bay City' } }),
			]),
		).toBeNull();
	});

	it('does not match a similar title at a different time', () => {
		expect(
			findDuplicate(planned, [
				mobilizeEvent({
					title: 'Ann Arbor Canvass Launch',
					timeslots: [
						{ id: 2, start_date: Date.parse('2026-08-15T00:00:00Z') / 1000, end_date: 0 },
					],
				}),
			]),
		).toBeNull();
	});

	it('normalizes punctuation and case', () => {
		expect(normalizeTitle('🗳️ Finish Strong: Final-Stretch Canvass!')).toBe(
			'finish strong final stretch canvass',
		);
	});

	it('scores overlapping titles above unrelated ones', () => {
		expect(titleSimilarity('Detroit Canvass Launch', 'Canvass Launch in Detroit')).toBe(1);
		expect(titleSimilarity('Detroit Canvass', 'Bay City Concert')).toBe(0);
	});
});

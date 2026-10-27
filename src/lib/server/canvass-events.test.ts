import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	SolidarityEvent,
	SolidaritySession,
} from '../../../mobilize-migrator/lib/solidarity.js';

vi.mock('./env.js', () => ({ SOLIDARITY_API_TOKEN: 't' }));
const getSolidarityEventRecords = vi.hoisted(() =>
	vi.fn<
		(
			token: string,
			opts?: { staleWhileRevalidate?: boolean },
		) => Promise<{
			items: SolidarityEvent[];
		}>
	>(),
);
vi.mock('./autocomplete-sources.js', () => ({ getSolidarityEventRecords }));

const {
	canvassCards,
	countCanvassesNear,
	loadCanvassEvents,
	MAX_CANVASS_CARDS,
	MAX_SESSIONS_PER_CARD,
} = await import('./canvass-events.js');

const NOW = new Date('2026-10-26T16:00:00Z');
const HOUR = 3_600_000;
const CHAPTER = 42;

function session(over: Partial<SolidaritySession> = {}): SolidaritySession {
	const start = over.start_time ?? new Date(NOW.getTime() + 24 * HOUR).toISOString();
	return {
		id: 7,
		title: null,
		start_time: start,
		end_time: new Date(Date.parse(start) + 3 * HOUR).toISOString(),
		location_name: 'Union Hall',
		location_address: '12 Main St, Flint, MI',
		location_data: { coordinates: '{"lat":43.01,"lng":-83.69}' },
		max_capacity: null,
		event_type: 'in_person',
		...over,
	};
}

function event(over: Partial<SolidarityEvent> = {}): SolidarityEvent {
	return {
		id: 100,
		title: 'Saturday door knock',
		event_type: 'in_person',
		scope_id: CHAPTER,
		scope_type: 'Chapter',
		description: 'Knock doors with us.',
		event_page_id: 1,
		event_page_url: 'https://solidarity.example/e/100',
		image_url: null,
		hide_address_until_rsvp: false,
		is_co_hosted_mirror: false,
		primary_event_id: 100,
		tags: ['Canvass '],
		event_sessions: [session()],
		...over,
	};
}

const opts = { tag: 'canvass', chapterId: CHAPTER, now: NOW };

describe('canvassCards', () => {
	it('turns a tagged session into a card', () => {
		expect(canvassCards([event()], opts)).toEqual([
			{
				id: '100-7',
				title: 'Saturday door knock',
				place: 'Union Hall · 12 Main St, Flint, MI',
				description: 'Knock doors with us.',
				point: { lat: 43.01, lng: -83.69 },
				sessions: [
					{
						id: '100-7',
						dayLabel: 'Tomorrow',
						timeLabel: '12:00 PM – 3:00 PM',
						startsAt: '2026-10-27T16:00:00.000Z',
						endsAt: '2026-10-27T19:00:00.000Z',
						title: null,
						rsvpUrl: 'https://solidarity.example/e/100',
					},
				],
			},
		]);
	});

	it('matches the tag ignoring case and surrounding spaces', () => {
		expect(canvassCards([event({ tags: ['  CANVASS'] })], opts)).toHaveLength(1);
		expect(canvassCards([event({ tags: ['canvassing'] })], opts)).toHaveLength(0);
		expect(canvassCards([event({ tags: null })], opts)).toHaveLength(0);
	});

	it('shows nothing without a tag', () => {
		expect(canvassCards([event({ tags: [''] })], { ...opts, tag: '' })).toEqual([]);
	});

	it("keeps only the chapter's own events", () => {
		expect(canvassCards([event({ scope_id: CHAPTER + 1 })], opts)).toEqual([]);
		expect(canvassCards([event({ scope_type: 'Organization' })], opts)).toEqual([]);
	});

	it('leaves off events that hide their address, and mirrors', () => {
		expect(canvassCards([event({ hide_address_until_rsvp: true })], opts)).toEqual([]);
		expect(canvassCards([event({ is_co_hosted_mirror: true })], opts)).toEqual([]);
	});

	it('leaves off events with no Solidarity page to RSVP on', () => {
		expect(canvassCards([event({ event_page_url: null })], opts)).toEqual([]);
		expect(canvassCards([event({ event_page_url: '  ' })], opts)).toEqual([]);
	});

	it('leaves off sessions that are virtual, unplaced or have no place', () => {
		const sessions = [
			session({ id: 1, event_type: 'virtual' }),
			session({ id: 2, location_data: null }),
			session({ id: 3, location_data: { coordinates: 'not json' } }),
			session({ id: 4, location_name: null, location_address: null }),
		];
		expect(canvassCards([event({ event_sessions: sessions })], opts)).toEqual([]);
	});

	it("takes sessions that haven't ended and start within the next week, soonest first", () => {
		const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
		const sessions = [
			session({ id: 1, start_time: at(-HOUR) }),
			session({ id: 2, start_time: at(0) }),
			session({ id: 3, start_time: at(7 * 24 * HOUR) }),
			session({ id: 4, start_time: at(7 * 24 * HOUR + 1) }),
			session({ id: 5, start_time: at(2 * HOUR) }),
			session({ id: 6, start_time: at(-4 * HOUR), end_time: at(-HOUR) }),
			session({ id: 7, start_time: at(-HOUR), end_time: at(-HOUR) }),
			session({ id: 8, start_time: at(-4 * HOUR), end_time: at(0) }),
		];
		const [card] = canvassCards([event({ event_sessions: sessions })], opts);
		expect(card.sessions.map((s) => s.id)).toEqual(['100-1', '100-2', '100-5', '100-3']);
	});

	it('prefers the session title and falls back to the address alone', () => {
		const [card] = canvassCards(
			[event({ event_sessions: [session({ title: 'Morning shift', location_name: null })] })],
			opts,
		);
		expect(card.title).toBe('Morning shift');
		expect(card.place).toBe('12 Main St, Flint, MI');
	});

	it('makes one card per place, named and described by its soonest session', () => {
		const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();
		const elsewhere = { coordinates: '{"lat":43.2,"lng":-83.5}' };
		const cards = canvassCards(
			[
				event({
					event_sessions: [
						session({ id: 1, start_time: at(30) }),
						session({ id: 2, start_time: at(5) }),
						session({ id: 3, start_time: at(10), location_data: elsewhere }),
					],
				}),
				event({
					id: 200,
					title: 'Lit drop',
					description: 'Flyers.',
					event_page_url: 'https://solidarity.example/e/200',
					event_sessions: [session({ id: 9, start_time: at(20) })],
				}),
			],
			opts,
		);
		expect(cards.map((c) => c.id)).toEqual(['100-2', '100-3']);
		const [hall] = cards;
		expect(hall.title).toBe('Saturday door knock');
		expect(hall.description).toBe('Knock doors with us.');
		// The other event's session says which event it is, and RSVPs to it.
		expect(hall.sessions.map((s) => [s.id, s.title, s.rsvpUrl])).toEqual([
			['100-2', null, 'https://solidarity.example/e/100'],
			['200-9', 'Lit drop', 'https://solidarity.example/e/200'],
			['100-1', null, 'https://solidarity.example/e/100'],
		]);
	});

	it('caps the places and the sessions at each', () => {
		const at = (i: number) => new Date(NOW.getTime() + (i + 1) * HOUR).toISOString();
		const spread = Array.from({ length: MAX_CANVASS_CARDS + 3 }, (_, i) =>
			session({
				id: i,
				start_time: at(i),
				location_data: { coordinates: `{"lat":${43 + i / 10},"lng":-83.69}` },
			}),
		);
		expect(canvassCards([event({ event_sessions: spread })], opts)).toHaveLength(MAX_CANVASS_CARDS);
		const stacked = Array.from({ length: MAX_SESSIONS_PER_CARD + 3 }, (_, i) =>
			session({ id: i, start_time: at(i) }),
		);
		const [card] = canvassCards([event({ event_sessions: stacked })], opts);
		expect(card.sessions).toHaveLength(MAX_SESSIONS_PER_CARD);
	});
});

describe('countCanvassesNear', () => {
	const near = { lat: 43.01, lng: -83.69 };
	const base = { tag: 'canvass', chapterIds: [CHAPTER], point: near, radiusMiles: 2, now: NOW };

	it('counts each session within the radius, across the chapters given', () => {
		const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();
		const events = [
			event({
				event_sessions: [
					session({ id: 1, start_time: at(5) }),
					session({ id: 2, start_time: at(30) }),
					// About 14 miles away.
					session({
						id: 3,
						start_time: at(10),
						location_data: { coordinates: '{"lat":43.2,"lng":-83.69}' },
					}),
				],
			}),
			event({ id: 200, scope_id: CHAPTER + 1, event_sessions: [session({ id: 9 })] }),
		];
		expect(countCanvassesNear(events, base)).toBe(2);
		expect(countCanvassesNear(events, { ...base, chapterIds: [CHAPTER, CHAPTER + 1] })).toBe(3);
	});

	it('applies the same rules as the cards', () => {
		expect(countCanvassesNear([event({ event_page_url: null })], base)).toBe(0);
		expect(countCanvassesNear([event({ hide_address_until_rsvp: true })], base)).toBe(0);
		expect(countCanvassesNear([event()], { ...base, tag: '' })).toBe(0);
	});
});

describe('loadCanvassEvents', () => {
	beforeEach(() => {
		getSolidarityEventRecords.mockReset();
	});
	afterEach(() => vi.restoreAllMocks());

	it("doesn't ask Solidarity when there's no tag", async () => {
		expect(await loadCanvassEvents({ ...opts, tag: '' })).toEqual([]);
		expect(getSolidarityEventRecords).not.toHaveBeenCalled();
	});

	it('reads the shared list without waiting on a refresh', async () => {
		getSolidarityEventRecords.mockResolvedValue({ items: [event()] });
		expect(await loadCanvassEvents(opts)).toHaveLength(1);
		expect(getSolidarityEventRecords).toHaveBeenCalledWith('t', { staleWhileRevalidate: true });
	});

	it('shows nothing, without throwing, when Solidarity fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		getSolidarityEventRecords.mockRejectedValue(new Error('503'));
		expect(await loadCanvassEvents(opts)).toEqual([]);
	});
});

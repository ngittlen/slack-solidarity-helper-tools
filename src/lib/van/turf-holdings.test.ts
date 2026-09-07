import { describe, it, expect } from 'vitest';
import {
	anyDeltaMeasured,
	currentHoldings,
	distinctHolders,
	DUE_SOON_WITHIN_HOURS,
	EXPIRING_WITHIN_HOURS,
	suspectCompletions,
	summarise,
	urgencyFor,
	type CompletionRow,
	type HoldingRow,
} from './turf-holdings.js';
import { EXPIRY_WARNING_LEAD_HOURS } from './expiry-warning.js';

const NOW = new Date('2026-09-02T18:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function row(over: Partial<HoldingRow> = {}): HoldingRow {
	return {
		checkoutId: 1,
		mapRouteId: 100,
		turfName: 'Turf 01',
		regionName: 'Ann Arbor',
		chapterId: 71,
		chapterName: 'Washtenaw County',
		doorCount: 250,
		slackUserId: 'U_VOL',
		slackUserName: 'Dana',
		claimedAt: iso(NOW.getTime() - 10 * HOUR),
		expiresAt: iso(NOW.getTime() + 30 * HOUR),
		releasedAt: null,
		completedAt: null,
		expiryWarnedAt: null,
		...over,
	};
}

describe('currentHoldings', () => {
	it('reports a live claim with the numbers an organizer reads', () => {
		const [held] = currentHoldings([row()], NOW);
		expect(held).toMatchObject({
			turfName: 'Turf 01',
			slackUserName: 'Dana',
			doorCount: 250,
			hoursLeft: 30,
			hoursHeld: 10,
			urgency: 'fine',
			warned: false,
		});
	});

	// A board showing turf someone gave back an hour ago sends an organizer
	// chasing a volunteer who did the right thing.
	it.each([
		['released', { releasedAt: iso(NOW.getTime() - HOUR) }],
		['completed', { completedAt: iso(NOW.getTime() - HOUR) }],
		['already lapsed', { expiresAt: iso(NOW.getTime() - HOUR) }],
	])('excludes a claim that is %s', (_label, over) => {
		expect(currentHoldings([row(over)], NOW)).toEqual([]);
	});

	// Same rule isActive uses everywhere else in the ledger.
	it('excludes a claim with an unparseable expiry', () => {
		expect(currentHoldings([row({ expiresAt: 'not a date' })], NOW)).toEqual([]);
	});

	it('reads hoursHeld as zero rather than throwing on a corrupt claim time', () => {
		const [held] = currentHoldings([row({ claimedAt: 'nonsense' })], NOW);
		expect(held!.hoursHeld).toBe(0);
	});

	it('orders soonest to lapse first', () => {
		const holdings = currentHoldings(
			[
				row({ checkoutId: 1, mapRouteId: 1, expiresAt: iso(NOW.getTime() + 30 * HOUR) }),
				row({ checkoutId: 2, mapRouteId: 2, expiresAt: iso(NOW.getTime() + 2 * HOUR) }),
				row({ checkoutId: 3, mapRouteId: 3, expiresAt: iso(NOW.getTime() + 12 * HOUR) }),
			],
			NOW,
		);
		expect(holdings.map((h) => h.checkoutId)).toEqual([2, 3, 1]);
	});

	it('breaks a tie stably so the board does not shuffle between refreshes', () => {
		const at = iso(NOW.getTime() + 5 * HOUR);
		const holdings = currentHoldings(
			[
				row({ checkoutId: 9, mapRouteId: 9, expiresAt: at }),
				row({ checkoutId: 2, mapRouteId: 2, expiresAt: at }),
			],
			NOW,
		);
		expect(holdings.map((h) => h.checkoutId)).toEqual([2, 9]);
	});

	it('reports whether the volunteer has already been warned', () => {
		const warned = row({ expiryWarnedAt: iso(NOW.getTime() - HOUR) });
		expect(currentHoldings([warned], NOW)[0]!.warned).toBe(true);
	});

	it('handles an empty ledger', () => {
		expect(currentHoldings([], NOW)).toEqual([]);
	});
});

describe('urgencyFor', () => {
	// The board and the warning DM must agree about "about to lapse", or a row
	// flagged red implies a message that was never sent.
	it('uses the same window as the expiry warning', () => {
		expect(EXPIRING_WITHIN_HOURS).toBe(EXPIRY_WARNING_LEAD_HOURS);
	});

	it.each([
		[1, 'expiring'],
		[EXPIRING_WITHIN_HOURS, 'expiring'],
		[EXPIRING_WITHIN_HOURS + 1, 'due-soon'],
		[DUE_SOON_WITHIN_HOURS, 'due-soon'],
		[DUE_SOON_WITHIN_HOURS + 1, 'fine'],
		[48, 'fine'],
	])('reads %i hours left as %s', (hours, expected) => {
		expect(urgencyFor(hours)).toBe(expected);
	});

	it('bands are ordered, so a shorter time is never less urgent', () => {
		expect(EXPIRING_WITHIN_HOURS).toBeLessThan(DUE_SOON_WITHIN_HOURS);
	});
});

describe('summarise', () => {
	const holdings = () =>
		currentHoldings(
			[
				row({ checkoutId: 1, mapRouteId: 1, slackUserId: 'U_A', doorCount: 100 }),
				row({ checkoutId: 2, mapRouteId: 2, slackUserId: 'U_A', doorCount: 200 }),
				row({
					checkoutId: 3,
					mapRouteId: 3,
					slackUserId: 'U_B',
					doorCount: 50,
					expiresAt: iso(NOW.getTime() + 2 * HOUR),
				}),
				row({
					checkoutId: 4,
					mapRouteId: 4,
					slackUserId: 'U_C',
					doorCount: 10,
					expiresAt: iso(NOW.getTime() + 3 * HOUR),
					expiryWarnedAt: iso(NOW.getTime() - HOUR),
				}),
			],
			NOW,
		);

	it('counts turfs and doors that are out', () => {
		expect(summarise(holdings())).toMatchObject({ turfsOut: 4, doorsOut: 360 });
	});

	// "How many people are out today" — someone holding two counts once.
	it('counts holders, not holdings', () => {
		expect(summarise(holdings()).holders).toBe(3);
	});

	it('counts what is expiring', () => {
		expect(summarise(holdings()).expiring).toBe(2);
	});

	// The number that means someone has to pick up a phone: about to lapse and
	// the volunteer has not heard from us.
	it('counts expiring turf whose holder was never warned', () => {
		expect(summarise(holdings()).expiringUnwarned).toBe(1);
	});

	it('is all zeroes on an empty board', () => {
		expect(summarise([])).toEqual({
			turfsOut: 0,
			holders: 0,
			doorsOut: 0,
			expiring: 0,
			expiringUnwarned: 0,
		});
	});
});

describe('distinctHolders', () => {
	it('counts each volunteer once', () => {
		const holdings = currentHoldings(
			[
				row({ checkoutId: 1, mapRouteId: 1, slackUserId: 'U_A' }),
				row({ checkoutId: 2, mapRouteId: 2, slackUserId: 'U_A' }),
				row({ checkoutId: 3, mapRouteId: 3, slackUserId: 'U_B' }),
			],
			NOW,
		);
		expect(distinctHolders(holdings)).toBe(2);
	});
});

describe('suspectCompletions', () => {
	function completion(over: Partial<CompletionRow> = {}): CompletionRow {
		return {
			checkoutId: 1,
			mapRouteId: 100,
			turfName: 'Turf 01',
			regionName: 'Ann Arbor',
			chapterId: 71,
			chapterName: 'Washtenaw County',
			slackUserId: 'U_VOL',
			slackUserName: 'Dana',
			completedAt: '2026-09-01T18:00:00.000Z',
			confirmedDoorDelta: null,
			...over,
		};
	}

	it('flags a completion whose door count did not move', () => {
		const out = suspectCompletions([completion({ confirmedDoorDelta: 0 })]);
		expect(out).toHaveLength(1);
		expect(out[0]!.turfName).toBe('Turf 01');
	});

	it('ignores a completion that cleared doors', () => {
		expect(suspectCompletions([completion({ confirmedDoorDelta: 120 })])).toEqual([]);
	});

	// The distinction the whole pane hangs on. Null means the post-completion
	// refresh has not run — today that is every completion — and listing those
	// as suspect would accuse every volunteer of something nobody has checked.
	it('never treats an unmeasured delta as a zero one', () => {
		expect(suspectCompletions([completion({ confirmedDoorDelta: null })])).toEqual([]);
	});

	it('separates unmeasured from measured-and-zero in one batch', () => {
		const out = suspectCompletions([
			completion({ checkoutId: 1, confirmedDoorDelta: null }),
			completion({ checkoutId: 2, confirmedDoorDelta: 0 }),
			completion({ checkoutId: 3, confirmedDoorDelta: 45 }),
		]);
		expect(out.map((c) => c.checkoutId)).toEqual([2]);
	});

	it('lists the most recent first', () => {
		const out = suspectCompletions([
			completion({ checkoutId: 1, completedAt: '2026-08-30T10:00:00.000Z', confirmedDoorDelta: 0 }),
			completion({ checkoutId: 2, completedAt: '2026-09-01T10:00:00.000Z', confirmedDoorDelta: 0 }),
		]);
		expect(out.map((c) => c.checkoutId)).toEqual([2, 1]);
	});

	it('handles no completions at all', () => {
		expect(suspectCompletions([])).toEqual([]);
	});

	describe('anyDeltaMeasured', () => {
		// Drives two opposite empty states: "nothing to worry about" versus "we
		// have not checked yet", which must never share wording.
		it('is false while every delta is null', () => {
			expect(anyDeltaMeasured([completion(), completion({ checkoutId: 2 })])).toBe(false);
		});

		it('is true once any delta has been measured, including a zero', () => {
			expect(anyDeltaMeasured([completion({ confirmedDoorDelta: 0 })])).toBe(true);
			expect(anyDeltaMeasured([completion({ confirmedDoorDelta: 90 })])).toBe(true);
		});

		it('is false with no completions', () => {
			expect(anyDeltaMeasured([])).toBe(false);
		});
	});
});

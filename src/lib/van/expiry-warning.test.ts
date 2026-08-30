import { describe, it, expect } from 'vitest';
import {
	EXPIRY_WARNING_LEAD_HOURS,
	needsExpiryWarning,
	renderExpiryWarning,
	type WarnableClaim,
} from './expiry-warning.js';

const NOW = new Date('2026-08-24T18:00:00.000Z');
const HOUR = 3_600_000;

function claim(over: Partial<WarnableClaim> = {}): WarnableClaim {
	return {
		mapRouteId: 100,
		slackUserId: 'U_VOL',
		slackUserName: 'Dana',
		claimedAt: '2026-08-23T18:00:00.000Z',
		// Four hours out — inside the six-hour lead window.
		expiresAt: new Date(NOW.getTime() + 4 * HOUR).toISOString(),
		releasedAt: null,
		completedAt: null,
		expiryWarnedAt: null,
		...over,
	};
}

describe('needsExpiryWarning', () => {
	it('warns a live claim inside the lead window', () => {
		expect(needsExpiryWarning(claim(), NOW)).toBe(true);
	});

	it('stays quiet outside the lead window', () => {
		const far = claim({ expiresAt: new Date(NOW.getTime() + 20 * HOUR).toISOString() });
		expect(needsExpiryWarning(far, NOW)).toBe(false);
	});

	// The stamp is the idempotency key: this sweep runs every half hour for six
	// hours, so without it one turf would produce twelve reminders.
	it('warns only once', () => {
		const warned = claim({ expiryWarnedAt: '2026-08-24T17:00:00.000Z' });
		expect(needsExpiryWarning(warned, NOW)).toBe(false);
	});

	it.each([
		['released', { releasedAt: '2026-08-24T17:00:00.000Z' }],
		['completed', { completedAt: '2026-08-24T17:00:00.000Z' }],
	])('does not warn about a claim already %s', (_label, over) => {
		expect(needsExpiryWarning(claim(over), NOW)).toBe(false);
	});

	// Worse than saying nothing: the turf is already back in the pool.
	it('does not warn about a claim that has already lapsed', () => {
		const lapsed = claim({ expiresAt: new Date(NOW.getTime() - HOUR).toISOString() });
		expect(needsExpiryWarning(lapsed, NOW)).toBe(false);
	});

	it('does not warn at the exact moment of expiry', () => {
		expect(needsExpiryWarning(claim({ expiresAt: NOW.toISOString() }), NOW)).toBe(false);
	});

	// A corrupt timestamp reads as long past everywhere else in the ledger, and
	// must not become a claim that is warned about forever.
	it('does not warn on an unparseable expiry', () => {
		expect(needsExpiryWarning(claim({ expiresAt: 'not a date' }), NOW)).toBe(false);
	});

	describe('the lead window boundary', () => {
		it('warns at exactly the lead time', () => {
			const at = claim({
				expiresAt: new Date(NOW.getTime() + EXPIRY_WARNING_LEAD_HOURS * HOUR).toISOString(),
			});
			expect(needsExpiryWarning(at, NOW)).toBe(true);
		});

		it('stays quiet just outside it', () => {
			const just = claim({
				expiresAt: new Date(
					NOW.getTime() + EXPIRY_WARNING_LEAD_HOURS * HOUR + 60_000,
				).toISOString(),
			});
			expect(needsExpiryWarning(just, NOW)).toBe(false);
		});

		it('honours a custom lead time', () => {
			const c = claim({ expiresAt: new Date(NOW.getTime() + 10 * HOUR).toISOString() });
			expect(needsExpiryWarning(c, NOW, 6)).toBe(false);
			expect(needsExpiryWarning(c, NOW, 12)).toBe(true);
		});
	});

	// Intended: "expires in two hours" is true and useful, and staying silent
	// because we could not warn early enough loses the volunteer the turf.
	it('warns immediately when the whole TTL is shorter than the lead time', () => {
		const short = claim({
			claimedAt: NOW.toISOString(),
			expiresAt: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
		});
		expect(needsExpiryWarning(short, NOW)).toBe(true);
	});
});

describe('renderExpiryWarning', () => {
	const input = {
		turfName: 'Turf 01',
		regionName: 'Ann Arbor',
		doorCount: 250,
		chapterId: 71,
		expiresAt: '2026-08-24T22:00:00.000Z',
		hoursLeft: 4,
		appUrl: 'https://app.example.org',
	};

	it('leads with the fact and the turf', () => {
		const text = renderExpiryWarning(input);
		expect(text).toContain('expires in about 4 hours');
		expect(text).toContain('Turf 01');
		expect(text).toContain('Ann Arbor');
		expect(text).toContain('250 doors');
	});

	it('states the deadline in campaign-local time', () => {
		// 22:00Z is 6:00 PM in Detroit under EDT — a volunteer reading "6 PM"
		// should not have to convert from UTC.
		expect(renderExpiryWarning(input)).toContain('6:00 PM');
	});

	it('offers both next steps, not just the one that suits us', () => {
		const text = renderExpiryWarning(input);
		expect(text).toContain('mark it done');
		expect(text).toContain('give it back');
	});

	it('says what happens if they do nothing', () => {
		expect(renderExpiryWarning(input)).toContain('goes back to the pool');
	});

	it('links to the turf page for the right chapter', () => {
		expect(renderExpiryWarning(input)).toContain('https://app.example.org/turfs?chapter=71');
	});

	it('singularises one hour', () => {
		expect(renderExpiryWarning({ ...input, hoursLeft: 1 })).toContain('about 1 hour.');
	});

	it('omits the region separator when a turf has no region', () => {
		const text = renderExpiryWarning({ ...input, regionName: '' });
		expect(text).toContain('*Turf 01* · 250 doors');
	});

	it('formats large door counts', () => {
		expect(renderExpiryWarning({ ...input, doorCount: 1250 })).toContain('1,250 doors');
	});

	// The number is issued at claim time and shown on the turf page. A second
	// place it gets sent is a second place to get wrong later.
	it('does not carry the MiniVAN list number', () => {
		const text = renderExpiryWarning(input).toLowerCase();
		for (const field of ['printedlist', 'list number', 'minivan']) {
			expect(text).not.toContain(field);
		}
	});
});

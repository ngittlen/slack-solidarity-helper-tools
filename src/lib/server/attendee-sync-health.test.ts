import { describe, expect, it } from 'vitest';

import { assessMatchHealth, type MatchHealthThresholds } from './attendee-sync-health.js';

const THRESHOLDS: MatchHealthThresholds = {
	minMatchRate: 0.1,
	matchRateMinSample: 25,
	maxAmbiguousRate: 0.25,
	ambiguousMinSample: 8,
};

/** Only the four counters the assessment reads. */
function report(over: Partial<Parameters<typeof assessMatchHealth>[0]> = {}) {
	return {
		lookupsPerformed: 0,
		lookupsAmbiguous: 0,
		matchedByEmail: 0,
		matchedByPhone: 0,
		...over,
	};
}

const kinds = (r: Parameters<typeof assessMatchHealth>[0]) =>
	assessMatchHealth(r, THRESHOLDS).findings.map((f) => f.kind);

describe('assessMatchHealth', () => {
	it('reports nothing when no lookups ran', () => {
		// An all-unchanged re-run does no lookups. Dividing by zero there would
		// invent a 0% match rate and alert on a run that did nothing wrong.
		const health = assessMatchHealth(report(), THRESHOLDS);

		expect(health.matchRate).toBeNull();
		expect(health.ambiguousRate).toBeNull();
		expect(health.findings).toEqual([]);
	});

	it('computes the rates against lookups performed', () => {
		const health = assessMatchHealth(
			report({ lookupsPerformed: 40, matchedByEmail: 12, matchedByPhone: 8, lookupsAmbiguous: 4 }),
			THRESHOLDS,
		);

		expect(health.matchRate).toBeCloseTo(0.5);
		expect(health.ambiguousRate).toBeCloseTo(0.1);
	});

	it('stays quiet on a real run: a big event full of genuinely new people', () => {
		// The 2026-08-26 nightly pass. 111 lookups, 20 matched, 0 ambiguous — a
		// genuine surge, and the shape that must never page anyone.
		expect(
			kinds(
				report({
					lookupsPerformed: 111,
					matchedByEmail: 19,
					matchedByPhone: 1,
					lookupsAmbiguous: 0,
				}),
			),
		).toEqual([]);
	});

	it('alarms when ambiguous lookups dominate', () => {
		// A lookup that stopped filtering returns the unfiltered list for
		// everyone, so every lookup comes back with more than one row.
		expect(
			kinds(report({ lookupsPerformed: 30, lookupsAmbiguous: 30, matchedByEmail: 0 })),
		).toEqual(['degraded-matching']);
	});

	it('suppresses the low-rate warning when matching is degraded', () => {
		// Both would fire; the ambiguity is the cause and the rate is the
		// symptom, and two posts for one problem is how alerts get ignored.
		expect(kinds(report({ lookupsPerformed: 40, lookupsAmbiguous: 40 }))).toEqual([
			'degraded-matching',
		]);
	});

	it('ignores ambiguity in a sample too small to mean anything', () => {
		// Two of five is above the rate, but five lookups says nothing.
		expect(kinds(report({ lookupsPerformed: 5, lookupsAmbiguous: 2 }))).toEqual([]);
	});

	it('warns on a collapsed match rate once the sample is big enough', () => {
		expect(kinds(report({ lookupsPerformed: 30, matchedByEmail: 1, lookupsAmbiguous: 0 }))).toEqual(
			['low-match-rate'],
		);
	});

	it('stays quiet on a low match rate in a small run', () => {
		// Below the floor, but 10 lookups is not evidence of anything.
		expect(kinds(report({ lookupsPerformed: 10, matchedByEmail: 0 }))).toEqual([]);
	});

	it('does not warn at the floor, only below it', () => {
		expect(kinds(report({ lookupsPerformed: 100, matchedByEmail: 10 }))).toEqual([]);
		expect(kinds(report({ lookupsPerformed: 100, matchedByEmail: 9 }))).toEqual(['low-match-rate']);
	});

	it('counts phone matches toward the rate', () => {
		// Regression guard: an early cut summed only matchedByEmail, which made
		// every phone-matched run look like a collapse.
		expect(kinds(report({ lookupsPerformed: 30, matchedByEmail: 0, matchedByPhone: 30 }))).toEqual(
			[],
		);
	});

	it('names the counts in the messages so Slack shows the evidence', () => {
		const degraded = assessMatchHealth(
			report({ lookupsPerformed: 30, lookupsAmbiguous: 30 }),
			THRESHOLDS,
		);
		expect(degraded.findings[0]!.message).toContain('30 of 30');
		expect(degraded.findings[0]!.message).toContain('100%');

		const low = assessMatchHealth(report({ lookupsPerformed: 30, matchedByEmail: 1 }), THRESHOLDS);
		expect(low.findings[0]!.message).toContain('1 of 30');
		expect(low.findings[0]!.message).toContain('10%');
	});
});

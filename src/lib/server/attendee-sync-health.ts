// Reads an attendee-sync report and decides whether the MATCHING looked healthy,
// as opposed to whether the run merely finished.
//
// Why this exists: the maxNewProfiles guardrail counts new profiles, so it fires
// on a big event just as readily as on a broken matcher, and a human has to tell
// the two apart by hand. Volume alone cannot separate them — a genuinely large
// signup surge and a lookup that has stopped filtering both end in "lots of new
// profiles". What separates them is WHY each lookup missed:
//
//   genuine surge      -> lookups return zero rows (nobody in the CRM yet)
//   lookup not filtering -> lookups return the unfiltered list, so every one is
//                           ambiguous and gets refused
//
// So `ambiguousRate` is the high-signal alarm and `matchRate` is the supporting
// number. A low match rate on its own is normal for public events — measured at
// 18% and 27% on real runs — which is why it warns rather than alarms, and only
// well below anything observed.
//
// Pure: no $env, no I/O, so the thresholds are injected and the whole thing is
// testable without a sync.

import type { AttendeeSyncReport } from '../../../mobilize-migrator/lib/attendee-sync.js';

export interface MatchHealthThresholds {
	/** Warn below this share of lookups resolving to an existing profile. */
	minMatchRate: number;
	/** Too few lookups to read anything into the match rate. */
	matchRateMinSample: number;
	/** Alarm at or above this share of lookups refused as ambiguous. */
	maxAmbiguousRate: number;
	/**
	 * Ambiguity needs a far smaller sample than the match rate to be meaningful:
	 * it sits at zero in normal operation, so a handful in a small run already
	 * says something, where a low match rate in a small run says nothing.
	 */
	ambiguousMinSample: number;
}

export type MatchHealthFinding =
	{ kind: 'degraded-matching'; message: string } | { kind: 'low-match-rate'; message: string };

export interface MatchHealth {
	/** Share of lookups that found an existing profile. Null when none ran. */
	matchRate: number | null;
	/** Share of lookups refused because the identifier hit more than one row. */
	ambiguousRate: number | null;
	findings: MatchHealthFinding[];
}

function percent(rate: number): string {
	return `${Math.round(rate * 100)}%`;
}

export function assessMatchHealth(
	report: Pick<
		AttendeeSyncReport,
		'lookupsPerformed' | 'lookupsAmbiguous' | 'matchedByEmail' | 'matchedByPhone'
	>,
	thresholds: MatchHealthThresholds,
): MatchHealth {
	const lookups = report.lookupsPerformed;
	if (lookups <= 0) return { matchRate: null, ambiguousRate: null, findings: [] };

	const matched = report.matchedByEmail + report.matchedByPhone;
	const matchRate = matched / lookups;
	const ambiguousRate = report.lookupsAmbiguous / lookups;
	const findings: MatchHealthFinding[] = [];

	const degraded =
		lookups >= thresholds.ambiguousMinSample && ambiguousRate >= thresholds.maxAmbiguousRate;

	if (degraded) {
		findings.push({
			kind: 'degraded-matching',
			message:
				`${report.lookupsAmbiguous} of ${lookups} lookups (${percent(ambiguousRate)}) matched ` +
				'more than one Solidarity profile and were refused. Normally this is near zero. ' +
				'Either the CRM has picked up a lot of duplicate people, or the user lookup has ' +
				'stopped filtering and is returning the whole user list — check that `email=` and ' +
				'`phone_number=` still filter before the next run writes anything.',
		});
	}

	// Suppressed when matching is degraded: the rate is low *because* of the
	// ambiguity, and two alerts for one cause is how alerts get ignored.
	if (
		!degraded &&
		lookups >= thresholds.matchRateMinSample &&
		matchRate < thresholds.minMatchRate
	) {
		findings.push({
			kind: 'low-match-rate',
			message:
				`only ${matched} of ${lookups} signups (${percent(matchRate)}) matched someone already ` +
				`in Solidarity, below the ${percent(thresholds.minMatchRate)} floor. A brand-new ` +
				'audience does look like this, so it is not necessarily wrong — but it is worth ' +
				'confirming the new profiles are real people before they pile up.',
		});
	}

	return { matchRate, ambiguousRate, findings };
}

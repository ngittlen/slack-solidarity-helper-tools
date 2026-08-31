import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EXPIRY_WARNING_LEAD_HOURS } from './expiry-warning.js';

// The expiry warning is only as good as the schedule that fires it.
//
// `sendExpiryWarnings` warns a volunteer when their claim is within
// EXPIRY_WARNING_LEAD_HOURS of lapsing — but it can only do that on a tick, so
// if two consecutive runs sit more than the lead time apart, every claim
// expiring in the shadow between them is swept away without its holder ever
// being told. That is not a hypothetical: the schedule used to stop at 03:07
// and resume at 11:07 UTC, and the two hours of expiry times from 09:08 were
// silently unwarnable.
//
// The workflow says "do not trim the overnight ticks" in a comment, and a
// comment does not survive someone looking at seven runs a night and seeing
// waste. This is that comment made executable — in the spirit of
// token-discipline.test.ts, which likewise reads files rather than behaviour.

const WORKFLOW = '.github/workflows/van-catalog-sync.yml';
const MINUTES_PER_DAY = 24 * 60;

/** Expand one cron field. Deliberately supports only the forms this workflow
 *  uses, and throws on anything else rather than guessing — a field this test
 *  cannot read is a field whose coverage it cannot vouch for. */
function expandField(field: string, min: number, max: number): number[] {
	const out = new Set<number>();
	for (const part of field.split(',')) {
		if (part === '*') {
			for (let i = min; i <= max; i++) out.add(i);
		} else if (/^\d+$/.test(part)) {
			out.add(Number(part));
		} else if (/^\d+-\d+$/.test(part)) {
			const [lo, hi] = part.split('-').map(Number) as [number, number];
			for (let i = lo; i <= hi; i++) out.add(i);
		} else {
			throw new Error(
				`Unsupported cron field "${part}" in ${WORKFLOW}. Extend this test rather than ` +
					'loosening it — an unparsed field is an unverified schedule.',
			);
		}
	}
	return [...out].sort((a, b) => a - b);
}

/** Every minute-of-day the workflow fires, from the file itself. */
function scheduledTicks(): number[] {
	const yaml = readFileSync(WORKFLOW, 'utf8');
	const lines = [...yaml.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]!);
	expect(lines.length).toBeGreaterThan(0);

	const ticks = new Set<number>();
	for (const line of lines) {
		const [minute, hour] = line.trim().split(/\s+/) as [string, string];
		for (const h of expandField(hour, 0, 23)) {
			for (const m of expandField(minute, 0, 59)) ticks.add(h * 60 + m);
		}
	}
	return [...ticks].sort((a, b) => a - b);
}

/** Longest run between consecutive ticks, wrapping midnight. */
function worstGapMinutes(ticks: number[]): number {
	return Math.max(
		...ticks.map(
			(t, i) => (ticks[(i + 1) % ticks.length]! - t + MINUTES_PER_DAY) % MINUTES_PER_DAY,
		),
	);
}

describe('van-catalog-sync schedule', () => {
	it('never leaves a gap longer than the warning lead time', () => {
		const gap = worstGapMinutes(scheduledTicks());
		expect(gap).toBeLessThanOrEqual(EXPIRY_WARNING_LEAD_HOURS * 60);
	});

	// A gap equal to the lead time warns, but only if that one run fires. GitHub
	// cron is best-effort, and the workflow's own comment promises that skipping
	// a run is harmless — this is what keeps that promise true.
	it('leaves room for missed runs rather than depending on every one', () => {
		const gap = worstGapMinutes(scheduledTicks());
		const missedRunsTolerated = Math.floor((EXPIRY_WARNING_LEAD_HOURS * 60) / gap) - 1;
		expect(missedRunsTolerated).toBeGreaterThanOrEqual(2);
	});

	// The property the two tests above are really about, stated directly: for
	// any moment a claim could expire, some run happens inside its lead window.
	it('covers every possible expiry time', () => {
		const ticks = scheduledTicks();
		const lead = EXPIRY_WARNING_LEAD_HOURS * 60;
		const uncovered: number[] = [];

		for (let expiry = 0; expiry < MINUTES_PER_DAY; expiry++) {
			const from = (expiry - lead + MINUTES_PER_DAY) % MINUTES_PER_DAY;
			const covered = ticks.some((t) =>
				from < expiry ? t >= from && t < expiry : t >= from || t < expiry,
			);
			if (!covered) uncovered.push(expiry);
		}

		const hhmm = (m: number) =>
			`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
		expect(
			uncovered.length === 0
				? 'none'
				: `${hhmm(uncovered[0]!)}-${hhmm(uncovered.at(-1)!)} UTC (${uncovered.length} min)`,
		).toBe('none');
	});

	it('refuses a cron expression it cannot verify', () => {
		expect(() => expandField('*/15', 0, 59)).toThrow(/Unsupported cron field/);
	});
});

import { describe, it, expect } from 'vitest';
import {
	clampTickerColumnsPerSecond,
	DEFAULT_TICKER_COLUMNS_PER_SECOND,
	RECOMMENDED_TICKER_RATES,
	MAX_TICKER_COLUMNS_PER_SECOND,
	MIN_TICKER_COLUMNS_PER_SECOND,
} from './ticker-speed.js';

describe('clampTickerColumnsPerSecond', () => {
	it('passes through a value inside the range', () => {
		expect(clampTickerColumnsPerSecond(20)).toBe(20);
	});

	it('keeps both endpoints', () => {
		expect(clampTickerColumnsPerSecond(MIN_TICKER_COLUMNS_PER_SECOND)).toBe(
			MIN_TICKER_COLUMNS_PER_SECOND,
		);
		expect(clampTickerColumnsPerSecond(MAX_TICKER_COLUMNS_PER_SECOND)).toBe(
			MAX_TICKER_COLUMNS_PER_SECOND,
		);
	});

	// A hand-edited app_config row shouldn't be able to hand the board a rate
	// that makes it unreadable or stuttery.
	it('clamps values outside the range', () => {
		expect(clampTickerColumnsPerSecond(0)).toBe(MIN_TICKER_COLUMNS_PER_SECOND);
		expect(clampTickerColumnsPerSecond(-40)).toBe(MIN_TICKER_COLUMNS_PER_SECOND);
		expect(clampTickerColumnsPerSecond(500)).toBe(MAX_TICKER_COLUMNS_PER_SECOND);
	});

	// NULL column (nothing configured) is the common case, not an error.
	it('falls back to the default for null, undefined and non-finite input', () => {
		for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
			expect(clampTickerColumnsPerSecond(bad)).toBe(DEFAULT_TICKER_COLUMNS_PER_SECOND);
		}
	});
});

describe('cadence constants', () => {
	it('the default is one of the recommended rates', () => {
		expect(RECOMMENDED_TICKER_RATES).toContain(DEFAULT_TICKER_COLUMNS_PER_SECOND);
	});

	// The settings slider offers exactly this span and lists these rates as the
	// smoothest, so they have to actually be reachable on it.
	it('every recommended rate is inside the slider range', () => {
		for (const rate of RECOMMENDED_TICKER_RATES) {
			expect(rate).toBeGreaterThanOrEqual(MIN_TICKER_COLUMNS_PER_SECOND);
			expect(rate).toBeLessThanOrEqual(MAX_TICKER_COLUMNS_PER_SECOND);
		}
	});

	// The defining property: a whole number of frames at 120 Hz. Rates that
	// also divide 60 are even on both; the rest (24, 40) alternate on a short
	// regular period at 60 Hz, which is what keeps them watchable.
	it('every recommended rate is a whole number of frames at 120 Hz', () => {
		for (const rate of RECOMMENDED_TICKER_RATES) {
			expect(120 % rate).toBe(0);
		}
	});

	it('is exactly the divisors of 120 in the usable range, in order', () => {
		const expected: number[] = [];
		for (let rate = 10; rate <= MAX_TICKER_COLUMNS_PER_SECOND; rate++) {
			if (120 % rate === 0) expected.push(rate);
		}
		expect([...RECOMMENDED_TICKER_RATES]).toEqual(expected);
	});

	// 40 is the only rate between 30 and 60 with a short regular cadence, so
	// dropping it would leave that whole band with nothing to recommend.
	it('covers the gap between 30 and 60', () => {
		const inGap = RECOMMENDED_TICKER_RATES.filter((r) => r > 30 && r < 60);
		expect(inGap).toEqual([40]);
	});
});

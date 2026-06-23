import { describe, it, expect } from 'vitest';
import { formatRelative } from './format-relative.js';

describe('formatRelative', () => {
	it('returns "just now" for any delta under one minute', () => {
		expect(formatRelative(0)).toBe('just now');
		expect(formatRelative(1)).toBe('just now');
		expect(formatRelative(59_000)).toBe('just now');
		expect(formatRelative(59_999)).toBe('just now');
	});

	it('returns "1m ago" exactly at the minute boundary', () => {
		expect(formatRelative(60_000)).toBe('1m ago');
	});

	it('returns minutes for deltas inside the hour window', () => {
		expect(formatRelative(2 * 60_000)).toBe('2m ago');
		expect(formatRelative(15 * 60_000)).toBe('15m ago');
		expect(formatRelative(59 * 60_000)).toBe('59m ago');
		// Just below the hour boundary still reads as minutes.
		expect(formatRelative(59 * 60_000 + 59_999)).toBe('59m ago');
	});

	it('returns "1h ago" exactly at the hour boundary', () => {
		expect(formatRelative(60 * 60_000)).toBe('1h ago');
	});

	it('returns hours for deltas inside the day window', () => {
		expect(formatRelative(2 * 60 * 60_000)).toBe('2h ago');
		expect(formatRelative(23 * 60 * 60_000)).toBe('23h ago');
		// Just below the day boundary still reads as hours.
		expect(formatRelative(23 * 60 * 60_000 + 59 * 60_000)).toBe('23h ago');
	});

	it('returns "1 day ago" (singular) at the day boundary', () => {
		expect(formatRelative(24 * 60 * 60_000)).toBe('1 day ago');
	});

	it('returns "N days ago" (plural) past 48 hours', () => {
		expect(formatRelative(2 * 24 * 60 * 60_000)).toBe('2 days ago');
		expect(formatRelative(7 * 24 * 60 * 60_000)).toBe('7 days ago');
	});

	it('clamps negative deltas (clock skew) to "just now" rather than rendering future tense', () => {
		expect(formatRelative(-1)).toBe('just now');
		expect(formatRelative(-60_000)).toBe('just now');
	});
});

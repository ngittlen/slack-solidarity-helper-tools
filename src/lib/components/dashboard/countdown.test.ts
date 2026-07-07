import { describe, it, expect } from 'vitest';
import { countdownParts, isoToLocalInput, localInputToIso } from './countdown.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('countdownParts', () => {
	it('splits a remaining duration into days, hours, minutes, seconds', () => {
		const now = 1_700_000_000_000;
		expect(countdownParts(now + 3 * DAY + 5 * HOUR + 42 * MINUTE + 17_000, now)).toEqual({
			days: 3,
			hours: 5,
			minutes: 42,
			seconds: 17,
			expired: false,
		});
	});

	it('floors partial seconds (900ms left displays as 0s, not expired)', () => {
		const now = 1_700_000_000_000;
		expect(countdownParts(now + 900, now)).toEqual({
			days: 0,
			hours: 0,
			minutes: 0,
			seconds: 0,
			expired: false,
		});
	});

	it('rolls hours over at 24, minutes at 60, seconds at 60', () => {
		const now = 1_700_000_000_000;
		expect(countdownParts(now + 2 * DAY, now)).toEqual({
			days: 2,
			hours: 0,
			minutes: 0,
			seconds: 0,
			expired: false,
		});
		expect(countdownParts(now + 25 * HOUR + 61 * MINUTE + 61_000, now)).toEqual({
			days: 1,
			hours: 2,
			minutes: 2,
			seconds: 1,
			expired: false,
		});
	});

	it('clamps to zeros and reports expired once the end has passed', () => {
		const now = 1_700_000_000_000;
		expect(countdownParts(now, now)).toEqual({
			days: 0,
			hours: 0,
			minutes: 0,
			seconds: 0,
			expired: true,
		});
		expect(countdownParts(now - DAY, now)).toEqual({
			days: 0,
			hours: 0,
			minutes: 0,
			seconds: 0,
			expired: true,
		});
	});
});

describe('isoToLocalInput / localInputToIso', () => {
	it('round-trips a datetime-local value through ISO in any timezone', () => {
		const local = '2026-08-15T17:30';
		expect(isoToLocalInput(localInputToIso(local))).toBe(local);
	});

	it('round-trips an ISO instant through the local representation', () => {
		const iso = new Date('2026-08-15T12:00:00.000Z').toISOString();
		expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
	});

	it('maps empty and unparseable values to the empty string', () => {
		expect(isoToLocalInput('')).toBe('');
		expect(isoToLocalInput('not-a-date')).toBe('');
		expect(localInputToIso('')).toBe('');
		expect(localInputToIso('not-a-date')).toBe('');
	});
});

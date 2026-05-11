import { describe, it, expect } from 'vitest';
import { parseDaysParam } from './days.js';

function params(value?: string): URLSearchParams {
	const p = new URLSearchParams();
	if (value !== undefined) p.set('days', value);
	return p;
}

describe('parseDaysParam', () => {
	it('returns the default (7) when the parameter is missing', () => {
		expect(parseDaysParam(params())).toBe(7);
	});

	it('returns the default (7) when the parameter is empty', () => {
		expect(parseDaysParam(params(''))).toBe(7);
	});

	it('returns the default (7) when the parameter is non-numeric', () => {
		expect(parseDaysParam(params('abc'))).toBe(7);
	});

	it('returns 7 for exact 7', () => {
		expect(parseDaysParam(params('7'))).toBe(7);
	});

	it('returns 30 for exact 30', () => {
		expect(parseDaysParam(params('30'))).toBe(30);
	});

	it('returns 90 for exact 90', () => {
		expect(parseDaysParam(params('90'))).toBe(90);
	});

	it('clamps 0 to the nearest preset (7)', () => {
		expect(parseDaysParam(params('0'))).toBe(7);
	});

	it('clamps -5 to the nearest preset (7)', () => {
		expect(parseDaysParam(params('-5'))).toBe(7);
	});

	it('clamps 3 to the nearest preset (7)', () => {
		expect(parseDaysParam(params('3'))).toBe(7);
	});

	it('snaps 18 to 7 (closer to 7 than to 30)', () => {
		expect(parseDaysParam(params('18'))).toBe(7);
	});

	it('snaps 19 to 30 (closer to 30 than to 7)', () => {
		expect(parseDaysParam(params('19'))).toBe(30);
	});

	it('snaps 50 to 30', () => {
		expect(parseDaysParam(params('50'))).toBe(30);
	});

	it('ties bias toward the wider preset: 60 -> 90', () => {
		expect(parseDaysParam(params('60'))).toBe(90);
	});

	it('snaps 120 down to 90', () => {
		expect(parseDaysParam(params('120'))).toBe(90);
	});

	it('snaps 9999 down to 90', () => {
		expect(parseDaysParam(params('9999'))).toBe(90);
	});
});

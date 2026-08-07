import { describe, it, expect } from 'vitest';
import { ordinal } from './ordinal.js';

describe('ordinal', () => {
	it('renders 1-10 as words', () => {
		expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(ordinal)).toEqual([
			'first',
			'second',
			'third',
			'fourth',
			'fifth',
			'sixth',
			'seventh',
			'eighth',
			'ninth',
			'tenth',
		]);
	});

	it('switches to numeric ordinals above ten', () => {
		expect(ordinal(11)).toBe('11th');
		expect(ordinal(14)).toBe('14th');
		expect(ordinal(20)).toBe('20th');
	});

	// The classic off-by-one-rule bug: these end in 1/2/3 but take 'th'.
	it.each([
		[11, '11th'],
		[12, '12th'],
		[13, '13th'],
		[111, '111th'],
		[112, '112th'],
		[113, '113th'],
		[1013, '1013th'],
	])('treats %i as a teen (%s)', (n, expected) => {
		expect(ordinal(n)).toBe(expected);
	});

	it.each([
		[21, '21st'],
		[22, '22nd'],
		[23, '23rd'],
		[24, '24th'],
		[101, '101st'],
		[102, '102nd'],
		[103, '103rd'],
		[121, '121st'],
	])('suffixes %i as %s', (n, expected) => {
		expect(ordinal(n)).toBe(expected);
	});

	it('handles round hundreds and thousands', () => {
		expect(ordinal(100)).toBe('100th');
		expect(ordinal(1000)).toBe('1000th');
	});

	// This string goes into a DM to a real person — it must never render NaN or
	// throw, whatever nonsense reaches it.
	it.each([0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		'degrades %p to "first" rather than throwing',
		(n) => {
			expect(ordinal(n)).toBe('first');
		},
	);

	it('floors non-integers', () => {
		expect(ordinal(1.5)).toBe('first');
		expect(ordinal(11.9)).toBe('11th');
	});
});

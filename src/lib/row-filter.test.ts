import { describe, it, expect } from 'vitest';
import { matchesText } from './row-filter.js';

describe('matchesText', () => {
	const fields = ['Turf 05', 'Kent County', 'Dana Smith', null, undefined];

	it('matches everything when empty', () => {
		expect(matchesText('', fields)).toBe(true);
		expect(matchesText('   ', fields)).toBe(true);
	});

	it('ignores case', () => {
		expect(matchesText('KENT', fields)).toBe(true);
	});

	// Each word may sit in a different column.
	it('needs every word, each in any field', () => {
		expect(matchesText('kent dana', fields)).toBe(true);
		expect(matchesText('kent alex', fields)).toBe(false);
	});

	it('matches part of a field', () => {
		expect(matchesText('urf 0', fields)).toBe(true);
	});

	it('skips missing fields', () => {
		expect(matchesText('null', fields)).toBe(false);
	});
});

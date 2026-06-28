import { describe, it, expect } from 'vitest';
import { filterPickerItems, reconcileBlurInput } from './picker-logic.js';
import type { PickerItem } from './picker-types.js';

const channels: PickerItem<string>[] = [
	{ id: 'C1', label: '#general' },
	{ id: 'C2', label: '#announcements', sublabel: 'private' },
	{ id: 'C3', label: '#random' },
];

describe('filterPickerItems', () => {
	it('returns all items for an empty query', () => {
		expect(filterPickerItems(channels, '')).toEqual(channels);
		expect(filterPickerItems(channels, '   ')).toEqual(channels);
	});

	it('case-insensitive substring match on label', () => {
		expect(filterPickerItems(channels, 'GEN').map((i) => i.id)).toEqual(['C1']);
		expect(filterPickerItems(channels, 'ann').map((i) => i.id)).toEqual(['C2']);
	});

	it('case-insensitive substring match on sublabel', () => {
		expect(filterPickerItems(channels, 'priv').map((i) => i.id)).toEqual(['C2']);
	});

	it('returns empty array when nothing matches', () => {
		expect(filterPickerItems(channels, 'xyz')).toEqual([]);
	});

	it('matches in multiple items', () => {
		// '#' matches all three channels.
		expect(filterPickerItems(channels, '#').map((i) => i.id)).toEqual(['C1', 'C2', 'C3']);
	});
});

describe('reconcileBlurInput', () => {
	it('rejects unknown text (no match)', () => {
		expect(reconcileBlurInput(channels, 'xyz')).toEqual({ accept: false });
	});

	it('rejects empty text (even if there is a current selection)', () => {
		// The component will revert to the current selection's label visually,
		// but the no-callback-fires guarantee comes from reject here.
		expect(reconcileBlurInput(channels, '')).toEqual({ accept: false });
		expect(reconcileBlurInput(channels, '   ')).toEqual({ accept: false });
	});

	it('rejects a substring match (only exact label matches accept)', () => {
		// "gen" is a substring of "#general" but not an exact label — reject.
		expect(reconcileBlurInput(channels, 'gen')).toEqual({ accept: false });
	});

	it('accepts an exact label match (case-insensitive)', () => {
		expect(reconcileBlurInput(channels, '#general')).toEqual({ accept: true, id: 'C1' });
		expect(reconcileBlurInput(channels, '#GENERAL')).toEqual({ accept: true, id: 'C1' });
		expect(reconcileBlurInput(channels, '  #general  ')).toEqual({ accept: true, id: 'C1' });
	});

	it('accepts a match even when input also matches another item as a substring', () => {
		// "#general" is exact for C1; "#" is substring for all three but irrelevant here.
		expect(reconcileBlurInput(channels, '#general')).toEqual({ accept: true, id: 'C1' });
	});

	it('preserves the typed-id type (number) for numeric ids', () => {
		const chapters: PickerItem<number>[] = [
			{ id: 1, label: 'NYC' },
			{ id: 2, label: 'SF' },
		];
		const result = reconcileBlurInput(chapters, 'NYC');
		expect(result).toEqual({ accept: true, id: 1 });
		if (result.accept) {
			// Type-level check: id is a number, not stringified.
			expect(typeof result.id).toBe('number');
		}
	});
});

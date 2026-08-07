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

// AutocompletePicker skips filterPickerItems entirely when a parent supplies
// `onSearch` (server-search mode). These pin down *why* that skip is required
// rather than merely an optimization: the server returns a capped page, and
// re-filtering it locally would narrow against that page instead of the real
// list.
describe('server-search mode: why local filtering must be skipped', () => {
	// The search endpoint caps results at 25. Simulate a roster where the
	// wanted person exists but fell outside that page.
	const serverPage = [
		{ id: 1, label: 'Jordan Alpha', sublabel: 'a@example.org' },
		{ id: 2, label: 'Jordan Beta', sublabel: 'b@example.org' },
	];

	it('local filtering would hide a result the server deliberately returned', () => {
		// Server matched these on an alternate email the labels don't contain.
		const hits = [{ id: 7, label: 'Sam Okafor', sublabel: 's.okafor@work.example.org' }];

		// If the picker re-filtered by what was typed, this correct hit vanishes.
		expect(filterPickerItems(hits, 'jordan')).toEqual([]);
		// Which is exactly why server-search mode renders `items` untouched.
	});

	it('local filtering narrows against the page, not the roster', () => {
		// Typing more after a broad query must re-query, not filter the page —
		// otherwise "Jordan Gamma" (absent from this page) can never be found.
		expect(filterPickerItems(serverPage, 'Jordan Gamma')).toEqual([]);
		expect(serverPage.some((i) => i.label === 'Jordan Gamma')).toBe(false);
	});

	it('blur reconciliation still works against the server page', () => {
		// The no-free-text guarantee is unchanged in server-search mode: only an
		// exact label match among the rendered items commits a selection.
		expect(reconcileBlurInput(serverPage, 'Jordan Alpha')).toEqual({ accept: true, id: 1 });
		expect(reconcileBlurInput(serverPage, 'Jordan')).toEqual({ accept: false });
		expect(reconcileBlurInput(serverPage, 'Jordan Gamma')).toEqual({ accept: false });
	});
});

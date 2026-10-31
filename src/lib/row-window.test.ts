import { describe, it, expect } from 'vitest';
import { RowWindow } from './row-window.svelte.js';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('RowWindow', () => {
	it('shows one page, then grows a page at a time', () => {
		const rows = range(7);
		const w = new RowWindow(
			() => rows,
			() => '',
			3,
		);
		expect(w.visible).toEqual([0, 1, 2]);
		expect(w.hasMore).toBe(true);
		w.more();
		expect(w.visible).toEqual([0, 1, 2, 3, 4, 5]);
		w.more();
		expect(w.visible).toEqual(rows);
		expect(w.hasMore).toBe(false);
	});

	it('has nothing more for a list shorter than a page', () => {
		const w = new RowWindow(
			() => range(2),
			() => '',
			3,
		);
		expect(w.visible).toEqual([0, 1]);
		expect(w.hasMore).toBe(false);
	});

	// A reload in place hands over a new array under the same filters. Shrinking
	// back to one page would collapse the table under the reader's scroll.
	it('keeps its growth when the array is replaced under the same key', () => {
		let rows = range(10);
		const w = new RowWindow(
			() => rows,
			() => '?chapter=71',
			3,
		);
		w.more();
		rows = range(12);
		expect(w.visible).toHaveLength(6);
	});

	it('starts over when the key changes', () => {
		let key = '?chapter=71';
		const w = new RowWindow(
			() => range(10),
			() => key,
			3,
		);
		w.more();
		key = '?chapter=72';
		expect(w.visible).toEqual([0, 1, 2]);
		w.more();
		expect(w.visible).toHaveLength(6);
	});
});

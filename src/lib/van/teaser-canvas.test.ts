import { describe, it, expect } from 'vitest';
import {
	dotsForLevel,
	stepWalkers,
	syncWalkers,
	type Field,
	type Walker,
} from './teaser-canvas.js';

const FIELD: Field = {
	cx: 500,
	cy: 400,
	pxPerMile: 100,
	width: 1000,
	height: 800,
	cells: [
		{ x: 520, y: 380, w: 4 },
		{ x: 300, y: 450, w: 1 },
	],
	cellPx: 25,
};

/** Deterministic, so a failure reproduces. */
function seeded(seed = 1) {
	let a = seed;
	return () => {
		a = (a * 16807) % 2147483647;
		return a / 2147483647;
	};
}

describe('dotsForLevel', () => {
	it('shows no dots for "no one"', () => {
		expect(dotsForLevel(0)).toBe(0);
	});

	it('scales the per-ring count up to the whole roaming area', () => {
		// "A few" is 4 in the ring; the grid is 3 mi against a 2 mi ring.
		expect(dotsForLevel(2)).toBe(Math.round(4 * 2.25));
	});

	it('shows nothing for a level it does not know', () => {
		expect(dotsForLevel(99)).toBe(0);
	});
});

describe('walkers', () => {
	it('grows and shrinks to the requested count', () => {
		const walkers: Walker[] = [];
		syncWalkers(walkers, 5, FIELD, 0, seeded());
		expect(walkers).toHaveLength(5);
		syncWalkers(walkers, 2, FIELD, 0, seeded());
		expect(walkers).toHaveLength(2);
	});

	it('spawns on turf', () => {
		const walkers: Walker[] = [];
		syncWalkers(walkers, 20, FIELD, 0, seeded(7));
		for (const w of walkers) {
			const near = FIELD.cells.some((c) => Math.hypot(c.x - w.x, c.y - w.y) <= FIELD.cellPx);
			expect(near).toBe(true);
		}
	});

	it('stays within the roaming radius over a long walk', () => {
		const walkers: Walker[] = [];
		const rand = seeded(3);
		syncWalkers(walkers, 10, FIELD, 0, rand);
		for (let i = 0; i < 20_000; i++) stepWalkers(walkers, FIELD, 0.05, rand);
		for (const w of walkers) {
			// 3 mi roam plus a little overshoot while turning back.
			expect(Math.hypot(w.x - FIELD.cx, w.y - FIELD.cy)).toBeLessThan(3.5 * FIELD.pxPerMile);
		}
	});
});

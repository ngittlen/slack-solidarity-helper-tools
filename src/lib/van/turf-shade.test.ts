import { describe, it, expect } from 'vitest';
import { turfShade, shadeLabel, DOOR_BANDS, type TurfShade } from './turf-shade.js';

describe('turfShade', () => {
	describe('status wins over door count', () => {
		it('paints your own turf as yours, whatever is left in it', () => {
			expect(turfShade('held-by-you', 0)).toBe('yours');
			expect(turfShade('held-by-you', 200)).toBe('yours');
		});

		// Door count is not something a viewer can act on when someone else is
		// walking the turf, so it must not compete with the hue that says so.
		it('paints someone else’s turf as taken, whatever is left in it', () => {
			expect(turfShade('checked-out', 0)).toBe('taken');
			expect(turfShade('checked-out', 1)).toBe('taken');
			expect(turfShade('checked-out', 200)).toBe('taken');
		});
	});

	describe('the door ramp', () => {
		it.each([
			[1, 'low'],
			[9, 'low'],
			[10, 'medium'],
			[29, 'medium'],
			[30, 'high'],
			[49, 'high'],
			[50, 'full'],
			[500, 'full'],
		])('paints %i doors as %s', (doors, shade) => {
			expect(turfShade('available', doors)).toBe(shade);
		});

		it('covers every band boundary without a gap', () => {
			const seen = new Set<TurfShade>();
			for (let doors = 1; doors <= 200; doors++) {
				seen.add(turfShade('available', doors));
			}
			expect([...seen].sort()).toEqual(['full', 'high', 'low', 'medium']);
		});
	});

	describe('zero doors', () => {
		// The distinction that decides whether walking over there is worth it.
		// One door is a trip; none is a wasted one.
		it('is a different shade from one door, not a paler one', () => {
			expect(turfShade('available', 0)).toBe('cleared');
			expect(turfShade('available', 1)).toBe('low');
			expect(turfShade('available', 0)).not.toBe(turfShade('available', 1));
		});

		it('is also distinct from turf someone is walking', () => {
			expect(turfShade('available', 0)).not.toBe(turfShade('checked-out', 0));
		});
	});

	describe('bad data', () => {
		it.each([
			['negative', -5],
			['NaN', Number.NaN],
			['Infinity', Number.POSITIVE_INFINITY],
		])('treats %s as cleared rather than falling through the bands', (_label, doors) => {
			const shade = turfShade('available', doors);
			// Infinity is a legitimate "lots", but it must still be a real band.
			expect(['cleared', 'full']).toContain(shade);
		});

		it('never returns undefined', () => {
			for (const doors of [0, 1, 9.5, 1e9, -0]) {
				expect(turfShade('available', doors)).toBeTruthy();
			}
		});
	});

	it('bands are ordered densest first, so find() picks the right one', () => {
		const mins = DOOR_BANDS.map((b) => b.min);
		expect([...mins].sort((a, b) => b - a)).toEqual(mins);
	});
});

describe('shadeLabel', () => {
	it('gives every shade a spoken form', () => {
		const shades: TurfShade[] = ['yours', 'taken', 'cleared', 'low', 'medium', 'high', 'full'];
		for (const shade of shades) {
			expect(shadeLabel(shade)).toBeTruthy();
		}
	});

	it('distinguishes an empty turf from a nearly finished one out loud', () => {
		// The ramp is invisible to a screen reader, so this is the only place
		// the distinction survives for that user.
		expect(shadeLabel('cleared')).not.toBe(shadeLabel('low'));
	});
});

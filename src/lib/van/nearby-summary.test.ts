import { describe, it, expect } from 'vitest';
import {
	CANVASSER_LEVELS,
	canvasserLevel,
	coarsePoint,
	densityGrid,
	doorsHeadline,
	parseCoordinates,
	placeLabel,
	type GridTurf,
} from './nearby-summary.js';

const ANN_ARBOR = { lat: 42.2808, lng: -83.743 };

describe('doorsHeadline', () => {
	it('floors to the nearest 50', () => {
		expect(doorsHeadline(372)).toEqual({ kind: 'over', atLeast: 350 });
		expect(doorsHeadline(350)).toEqual({ kind: 'over', atLeast: 350 });
		expect(doorsHeadline(50)).toEqual({ kind: 'over', atLeast: 50 });
		expect(doorsHeadline(12_549)).toEqual({ kind: 'over', atLeast: 12_500 });
	});

	it('says "a handful" below 50 rather than "over 0"', () => {
		expect(doorsHeadline(1)).toEqual({ kind: 'handful' });
		expect(doorsHeadline(49)).toEqual({ kind: 'handful' });
	});

	it('tells "all taken" apart from "no turf"', () => {
		expect(doorsHeadline(0, true)).toEqual({ kind: 'all-taken' });
		expect(doorsHeadline(0, false)).toEqual({ kind: 'none' });
	});

	it('says there is no turf at zero, and on nonsense', () => {
		expect(doorsHeadline(0)).toEqual({ kind: 'none' });
		expect(doorsHeadline(-5)).toEqual({ kind: 'none' });
		expect(doorsHeadline(Number.NaN)).toEqual({ kind: 'none' });
	});
});

describe('canvasserLevel', () => {
	const label = (n: number) => CANVASSER_LEVELS[canvasserLevel(n)]!.label;

	it('buckets at the agreed boundaries', () => {
		expect(label(0)).toBe('No one');
		expect(label(1)).toBe('A couple');
		expect(label(2)).toBe('A couple');
		expect(label(3)).toBe('A few');
		expect(label(5)).toBe('A few');
		expect(label(6)).toBe('A bunch');
		expect(label(10)).toBe('A bunch');
		expect(label(11)).toBe('Many');
		expect(label(20)).toBe('Many');
		expect(label(21)).toBe('Tons');
		expect(label(5000)).toBe('Tons');
	});

	it('treats nonsense as no one', () => {
		expect(label(-1)).toBe('No one');
		expect(label(Number.NaN)).toBe('No one');
	});
});

/** A square turf about a third of a mile on a side, centred on `centre`. */
function squareTurf(centre: { lat: number; lng: number }, doors: number): GridTurf {
	const d = 0.0025;
	return {
		doors,
		centre,
		hull: [
			{ lat: centre.lat - d, lng: centre.lng - d },
			{ lat: centre.lat - d, lng: centre.lng + d },
			{ lat: centre.lat + d, lng: centre.lng + d },
			{ lat: centre.lat + d, lng: centre.lng - d },
		],
	};
}

describe('densityGrid', () => {
	it('returns weights, never door totals', () => {
		const cells = densityGrid([squareTurf(ANN_ARBOR, 400)], ANN_ARBOR);
		expect(cells.length).toBeGreaterThan(0);
		for (const cell of cells) {
			expect(Object.keys(cell).sort()).toEqual(['lat', 'lng', 'w']);
			expect([1, 2, 3, 4]).toContain(cell.w);
		}
	});

	it('snaps to a fixed lattice, so moving the query does not move the cells', () => {
		const turfs = [squareTurf(ANN_ARBOR, 400)];
		const a = densityGrid(turfs, ANN_ARBOR);
		const b = densityGrid(turfs, { lat: ANN_ARBOR.lat + 0.0007, lng: ANN_ARBOR.lng - 0.0009 });
		expect(b).toEqual(a);
	});

	it('gives a turf too small to cover a cell centre its centroid cell', () => {
		const tiny: GridTurf = { doors: 30, centre: ANN_ARBOR, hull: [] };
		expect(densityGrid([tiny], ANN_ARBOR)).toHaveLength(1);
	});

	it('spreads a large turf over several cells', () => {
		// About 1.4 by 1 miles.
		const wide: GridTurf = {
			doors: 2000,
			centre: ANN_ARBOR,
			hull: [
				{ lat: ANN_ARBOR.lat - 0.01, lng: ANN_ARBOR.lng - 0.01 },
				{ lat: ANN_ARBOR.lat - 0.01, lng: ANN_ARBOR.lng + 0.01 },
				{ lat: ANN_ARBOR.lat + 0.01, lng: ANN_ARBOR.lng + 0.01 },
				{ lat: ANN_ARBOR.lat + 0.01, lng: ANN_ARBOR.lng - 0.01 },
			],
		};
		expect(densityGrid([wide], ANN_ARBOR).length).toBeGreaterThan(4);
	});

	it('leaves out turf beyond the grid radius and turf with no doors', () => {
		const far = squareTurf({ lat: ANN_ARBOR.lat + 0.2, lng: ANN_ARBOR.lng }, 400);
		const empty = squareTurf(ANN_ARBOR, 0);
		expect(densityGrid([far, empty], ANN_ARBOR)).toEqual([]);
	});

	it('bands by doors per cell', () => {
		const light: GridTurf = { doors: 5, centre: ANN_ARBOR, hull: [] };
		const heavy: GridTurf = { doors: 500, centre: ANN_ARBOR, hull: [] };
		expect(densityGrid([light], ANN_ARBOR)[0]!.w).toBe(1);
		expect(densityGrid([heavy], ANN_ARBOR)[0]!.w).toBe(4);
	});
});

describe('parseCoordinates', () => {
	it('rounds to three places', () => {
		expect(parseCoordinates('42.280812', '-83.743038')).toEqual({ lat: 42.281, lng: -83.743 });
	});

	it('refuses blanks, junk and out-of-range values', () => {
		expect(parseCoordinates('', '-83.7')).toBeNull();
		expect(parseCoordinates('42.2', null)).toBeNull();
		expect(parseCoordinates('north', '-83.7')).toBeNull();
		expect(parseCoordinates('91', '-83.7')).toBeNull();
		expect(parseCoordinates('42.2', '-181')).toBeNull();
	});
});

describe('coarsePoint', () => {
	it('rounds a geocoded address to about 100 m', () => {
		expect(coarsePoint({ lat: 42.2808123, lng: -83.7430987 })).toEqual({
			lat: 42.281,
			lng: -83.743,
		});
	});
});

describe('placeLabel', () => {
	it('names a ZIP, and never echoes an address', () => {
		expect(placeLabel({ kind: 'zip', zip: '48104' })).toBe('48104');
		expect(placeLabel({ kind: 'address' })).toBe('your address');
		expect(placeLabel({ kind: 'here' })).toBe('you');
	});
});

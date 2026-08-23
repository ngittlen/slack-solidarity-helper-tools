import { describe, it, expect } from 'vitest';
import {
	parseBounds,
	selectNearest,
	withinBounds,
	TURFS_PER_PAYLOAD,
	type Locatable,
} from './turf-paging.js';

function turf(id: number, name: string, lat: number | null, lng: number | null): Locatable {
	return { mapRouteId: id, name, centroidLat: lat, centroidLng: lng };
}

// Ann Arbor, roughly.
const HERE = { lat: 42.28, lng: -83.74 };

describe('selectNearest', () => {
	it('orders by distance when the volunteer’s location is known', () => {
		const rows = [
			turf(1, 'Far', 42.6, -83.2),
			turf(2, 'Near', 42.281, -83.741),
			turf(3, 'Middle', 42.35, -83.8),
		];
		const { selected } = selectNearest(rows, { location: HERE });
		expect(selected.map((t) => t.name)).toEqual(['Near', 'Middle', 'Far']);
	});

	it('falls back to name order with no location', () => {
		const rows = [turf(1, 'Charlie', 1, 1), turf(2, 'Alpha', 2, 2), turf(3, 'Bravo', 3, 3)];
		const { selected } = selectNearest(rows, { location: null });
		expect(selected.map((t) => t.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
	});

	// Turf without a centroid is real, claimable turf — and on a key without
	// export-job access it is ALL the turf there is.
	it('keeps turf with no centroid, sorted last', () => {
		const rows = [turf(1, 'No geometry', null, null), turf(2, 'Near', 42.281, -83.741)];
		const { selected } = selectNearest(rows, { location: HERE });
		expect(selected.map((t) => t.name)).toEqual(['Near', 'No geometry']);
		expect(selected).toHaveLength(2);
	});

	it('caps the payload and reports what it left out', () => {
		const rows = Array.from({ length: 400 }, (_, i) =>
			turf(i, `Turf ${String(i).padStart(3, '0')}`, 42 + i / 1000, -83),
		);
		const { selected, omitted } = selectNearest(rows, { limit: 150 });
		expect(selected).toHaveLength(150);
		expect(omitted).toBe(250);
	});

	it('reports nothing omitted when the chapter fits', () => {
		const rows = [turf(1, 'Only', 42, -83)];
		expect(selectNearest(rows).omitted).toBe(0);
	});

	it('does not mutate the caller’s array', () => {
		const rows = [turf(1, 'Zulu', 1, 1), turf(2, 'Alpha', 2, 2)];
		selectNearest(rows);
		expect(rows.map((t) => t.name)).toEqual(['Zulu', 'Alpha']);
	});

	it('defaults to the documented budget', () => {
		const rows = Array.from({ length: TURFS_PER_PAYLOAD + 10 }, (_, i) =>
			turf(i, `Turf ${i}`, 42, -83),
		);
		expect(selectNearest(rows).selected).toHaveLength(TURFS_PER_PAYLOAD);
	});

	it('handles an empty chapter', () => {
		expect(selectNearest([])).toEqual({ selected: [], omitted: 0 });
	});
});

describe('withinBounds', () => {
	const box = { minLat: 42, maxLat: 43, minLng: -84, maxLng: -83 };

	it('keeps turf inside the box', () => {
		expect(withinBounds([turf(1, 'In', 42.5, -83.5)], box).map((t) => t.mapRouteId)).toEqual([1]);
	});

	it('drops turf outside it', () => {
		expect(withinBounds([turf(1, 'Out', 44, -83.5)], box)).toEqual([]);
		expect(withinBounds([turf(2, 'Out', 42.5, -90)], box)).toEqual([]);
	});

	it('includes turf exactly on the edge', () => {
		expect(withinBounds([turf(1, 'Edge', 42, -84)], box)).toHaveLength(1);
	});

	it('drops turf with no centroid — the map is the only caller', () => {
		expect(withinBounds([turf(1, 'No geometry', null, null)], box)).toEqual([]);
	});
});

describe('parseBounds', () => {
	it('parses a well-formed bbox', () => {
		expect(parseBounds('42,-84,43,-83')).toEqual({
			minLat: 42,
			minLng: -84,
			maxLat: 43,
			maxLng: -83,
		});
	});

	it('tolerates whitespace', () => {
		expect(parseBounds(' 42 , -84 , 43 , -83 ')).not.toBeNull();
	});

	// A bad box must not silently match the whole world — that would hand back
	// the entire chapter in one request and undo the paging.
	it.each([
		['null', null],
		['empty', ''],
		['too few parts', '42,-84,43'],
		['too many parts', '42,-84,43,-83,1'],
		['non-numeric', '42,-84,43,east'],
		['latitude out of range', '42,-84,91,-83'],
		['longitude out of range', '42,-181,43,-83'],
		['inverted latitude', '43,-84,42,-83'],
		['inverted longitude', '42,-83,43,-84'],
	])('rejects %s', (_label, raw) => {
		expect(parseBounds(raw)).toBeNull();
	});
});

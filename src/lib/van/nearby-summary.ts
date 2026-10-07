// What a signed-out visitor to /turfs is told about the turf around them.
//
// The teaser answers three questions for someone who has not joined yet — how
// much work is near me, is anyone doing it, and where is it — without handing
// out anything the signed-in page guards. So everything here is an aggregate,
// and each one is coarsened BEFORE it leaves the server:
//
//   - doors are floored to the nearest 50 ("over 350"), never the count;
//   - canvassers are one of six levels ("a few"), never the count;
//   - where the turf is comes as a density grid of quarter-mile cells with a
//     weight of 1–4, never a hull, a name, a list number or a door total.
//
// The grid is anchored to a FIXED global lattice, not to the visitor's point.
// A grid centred on the query would move with it, and nudging the query a few
// metres at a time would let someone recover where cell boundaries fall inside
// a turf — which is exactly the precision the cells exist to throw away.
//
// Pure and dependency-free so the browser can use the level copy and the tests
// can pin the rounding without a database.

import { haversineMeters, type LatLng } from './geometry.js';

export const METRES_PER_MILE = 1609.344;

/** The radius the headline numbers describe. */
export const NEARBY_RADIUS_MILES = 2;

/** How far out the background grid reaches. Past the ring, so the blurred
 *  map has context around the edge instead of stopping at the circle. */
export const GRID_RADIUS_MILES = 3;

/** Grid cell edge. Coarse enough that a cell says "turf around here", not
 *  "this block". */
export const CELL_MILES = 0.25;

/** How far back a finished walk still counts as someone canvassing nearby. */
export const RECENT_ACTIVITY_HOURS = 24;

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

export type DoorsHeadline =
	/** No turf cut within the radius at all. */
	| { kind: 'none' }
	/** Turf exists, but every door of it is spoken for right now. */
	| { kind: 'all-taken' }
	/** 1–49: too few for "over 0" to read as anything but a joke. */
	| { kind: 'handful' }
	| { kind: 'over'; atLeast: number };

/**
 * Floor to the nearest 50: 372 → "over 350". `anyTurf` separates "nobody has
 * cut turf here" from "there is turf, but it is all taken" — two different
 * things to tell someone deciding whether to join.
 */
export function doorsHeadline(doors: number, anyTurf = doors > 0): DoorsHeadline {
	if (!Number.isFinite(doors) || doors <= 0)
		return anyTurf ? { kind: 'all-taken' } : { kind: 'none' };
	if (doors < 50) return { kind: 'handful' };
	return { kind: 'over', atLeast: Math.floor(doors / 50) * 50 };
}

// ---------------------------------------------------------------------------
// Canvassers
// ---------------------------------------------------------------------------

export interface CanvasserLevel {
	/** Highest head-count that still reads as this level. */
	max: number;
	label: string;
	sentence: string;
	/** Dots animated inside the 2-mile ring for this level. */
	dots: number;
}

export const CANVASSER_LEVELS: readonly CanvasserLevel[] = [
	{
		max: 0,
		label: 'No one',
		sentence: "No one's canvassing near you yet. You could be the first.",
		dots: 0,
	},
	{ max: 2, label: 'A couple', sentence: 'A couple of people are canvassing near you', dots: 2 },
	{ max: 5, label: 'A few', sentence: 'A few people are canvassing near you', dots: 4 },
	{ max: 10, label: 'A bunch', sentence: 'A bunch of people are canvassing near you', dots: 8 },
	{ max: 20, label: 'Many', sentence: 'Many people are canvassing near you', dots: 14 },
	{ max: Infinity, label: 'Tons', sentence: 'Tons of people are canvassing near you', dots: 24 },
];

/** Index into CANVASSER_LEVELS. The index is what goes to the browser. */
export function canvasserLevel(count: number): number {
	const n = Number.isFinite(count) ? Math.max(0, count) : 0;
	return CANVASSER_LEVELS.findIndex((level) => n <= level.max);
}

// ---------------------------------------------------------------------------
// Density grid
// ---------------------------------------------------------------------------

/** One grid cell as the browser sees it: its centre and a 1–4 weight. */
export interface DensityCell {
	lat: number;
	lng: number;
	w: 1 | 2 | 3 | 4;
}

/** A turf as the grid needs it. Doors are spread over the cells its hull
 *  covers, so a big turf reads as a wide patch rather than one hot cell. */
export interface GridTurf {
	doors: number;
	centre: LatLng;
	hull: readonly LatLng[];
}

// Doors per quarter-mile cell at which each weight starts. A dense suburban
// turf puts well over a hundred doors in a cell; a rural one a handful.
const WEIGHT_THRESHOLDS = [1, 20, 60, 120] as const;

const MILES_PER_DEGREE_LAT = 69.05;
const MILES_PER_DEGREE_LNG_AT_EQUATOR = 69.17;
const LAT_STEP = CELL_MILES / MILES_PER_DEGREE_LAT;

function lngStepForRow(row: number): number {
	const rowCentreLat = (row + 0.5) * LAT_STEP;
	const cos = Math.max(0.05, Math.cos((rowCentreLat * Math.PI) / 180));
	return CELL_MILES / (MILES_PER_DEGREE_LNG_AT_EQUATOR * cos);
}

interface CellRef {
	row: number;
	col: number;
}

function cellOf(point: LatLng): CellRef {
	const row = Math.floor(point.lat / LAT_STEP);
	return { row, col: Math.floor(point.lng / lngStepForRow(row)) };
}

function cellCentre({ row, col }: CellRef): LatLng {
	return { lat: (row + 0.5) * LAT_STEP, lng: (col + 0.5) * lngStepForRow(row) };
}

/** Ray-cast point-in-polygon. The hull is small enough that plain lat/lng is
 *  flat to well within a cell. */
function insidePolygon(point: LatLng, polygon: readonly LatLng[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i]!;
		const b = polygon[j]!;
		if (
			a.lat > point.lat !== b.lat > point.lat &&
			point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng
		) {
			inside = !inside;
		}
	}
	return inside;
}

/** The cells whose centres fall inside the hull, or the centroid's cell when
 *  the turf is too small (or has no hull) to cover a centre. */
function cellsCovering(turf: GridTurf): CellRef[] {
	if (turf.hull.length >= 3) {
		const lats = turf.hull.map((p) => p.lat);
		const lngs = turf.hull.map((p) => p.lng);
		const firstRow = Math.floor(Math.min(...lats) / LAT_STEP);
		const lastRow = Math.floor(Math.max(...lats) / LAT_STEP);
		const covered: CellRef[] = [];
		for (let row = firstRow; row <= lastRow; row++) {
			const step = lngStepForRow(row);
			const firstCol = Math.floor(Math.min(...lngs) / step);
			const lastCol = Math.floor(Math.max(...lngs) / step);
			for (let col = firstCol; col <= lastCol; col++) {
				if (insidePolygon(cellCentre({ row, col }), turf.hull)) covered.push({ row, col });
			}
		}
		if (covered.length > 0) return covered;
	}
	return [cellOf(turf.centre)];
}

function weightFor(doors: number): DensityCell['w'] | null {
	if (doors >= WEIGHT_THRESHOLDS[3]) return 4;
	if (doors >= WEIGHT_THRESHOLDS[2]) return 3;
	if (doors >= WEIGHT_THRESHOLDS[1]) return 2;
	if (doors >= WEIGHT_THRESHOLDS[0]) return 1;
	return null;
}

/**
 * Turf → banded quarter-mile cells within `radiusMiles` of `centre`.
 *
 * Only the weight band survives, never the door total, and cells are emitted
 * in a fixed order so the payload says nothing about which turf filled them.
 */
export function densityGrid(
	turfs: readonly GridTurf[],
	centre: LatLng,
	radiusMiles = GRID_RADIUS_MILES,
): DensityCell[] {
	const doorsByCell = new Map<string, { ref: CellRef; doors: number }>();
	for (const turf of turfs) {
		if (!(turf.doors > 0)) continue;
		const cells = cellsCovering(turf);
		const share = turf.doors / cells.length;
		for (const ref of cells) {
			const key = `${ref.row}:${ref.col}`;
			const entry = doorsByCell.get(key) ?? { ref, doors: 0 };
			entry.doors += share;
			doorsByCell.set(key, entry);
		}
	}

	const limit = radiusMiles * METRES_PER_MILE;
	const cells: (DensityCell & { row: number; col: number })[] = [];
	for (const { ref, doors } of doorsByCell.values()) {
		const w = weightFor(doors);
		if (w === null) continue;
		const at = cellCentre(ref);
		if (haversineMeters(centre, at) > limit) continue;
		cells.push({ lat: round(at.lat, 5), lng: round(at.lng, 5), w, ...ref });
	}
	cells.sort((a, b) => a.row - b.row || a.col - b.col);
	return cells.map(({ lat, lng, w }) => ({ lat, lng, w }));
}

// ---------------------------------------------------------------------------
// Place
// ---------------------------------------------------------------------------

/** Which kind of place a summary describes, so the page can say "of 48104",
 *  "of your address" or "of you" without echoing an address back. */
export type NearbyPlace = { kind: 'zip'; zip: string } | { kind: 'address' } | { kind: 'here' };

/** "48104", "your address", "you". */
export function placeLabel(place: NearbyPlace): string {
	if (place.kind === 'zip') return place.zip;
	return place.kind === 'address' ? 'your address' : 'you';
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function round(value: number, places: number): number {
	const f = 10 ** places;
	return Math.round(value * f) / f;
}

/**
 * Device coordinates from a form, or null.
 *
 * Rounded to three places (~100 m) on arrival. The browser rounds too, but
 * this is the boundary: the summary needs a neighbourhood, not a front door.
 */
export function parseCoordinates(rawLat: unknown, rawLng: unknown): LatLng | null {
	if (typeof rawLat !== 'string' || typeof rawLng !== 'string') return null;
	if (rawLat.trim() === '' || rawLng.trim() === '') return null;
	const lat = Number(rawLat);
	const lng = Number(rawLng);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
	return { lat: round(lat, 3), lng: round(lng, 3) };
}

/** Round a point for the payload. Same precision as parseCoordinates. */
export function coarsePoint(point: LatLng): LatLng {
	return { lat: round(point.lat, 3), lng: round(point.lng, 3) };
}

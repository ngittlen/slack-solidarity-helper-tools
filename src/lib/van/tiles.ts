// Web Mercator projection and slippy-map tile arithmetic.
//
// Split from geometry.ts because these are two different jobs: geometry.ts
// answers "what shape is this turf and how far away is it", which is spherical
// and viewport-free; this file answers "which 256px PNGs cover the screen and
// where do I paint them", which is Mercator and viewport-bound.
//
// Mercator specifically, not the equirectangular fit this replaced: raster
// basemap tiles are cut in Web Mercator (EPSG:3857), so any other projection
// would slide the polygons off the streets underneath them. The distortion
// Mercator introduces is irrelevant over a canvassing turf and mandatory for
// lining up with tiles.
//
// No dependency: a tile layer is a projection, a division and two loops, and
// Principle IV says don't add ~42 KB for that. What we give up by not taking
// Leaflet is real though — fractional zoom, tile retention during a zoom, and
// prefetch beyond the viewport. That accounting lives in full at the top of
// TurfMap.svelte, which is the file a swap would replace.

import type { BoundingBox, LatLng } from './geometry.js';

/** Standard slippy-map tile edge in CSS pixels. Retina tiles are 512 device
 *  pixels but still occupy 256 logical ones, which is why this doesn't change
 *  when the @2x URL is used. */
export const TILE_SIZE = 256;

/** Mercator is undefined at the poles; every provider clips here. */
const MAX_LATITUDE = 85.05112878;

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 19;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** lat/lng → the unit square, (0,0) at the north-west corner of the world. */
export function toWorld(point: LatLng): { x: number; y: number } {
	const lat = clamp(point.lat, -MAX_LATITUDE, MAX_LATITUDE);
	const sin = Math.sin((lat * Math.PI) / 180);
	return {
		x: (point.lng + 180) / 360,
		// The usual log-tangent form, written with the sine identity because it
		// stays stable as latitude approaches the clip. Clamped because at
		// exactly MAX_LATITUDE floating point lands a hair outside the unit
		// square, and a y of -6e-12 is a tile row of -1 downstream.
		y: clamp(0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI), 0, 1),
	};
}

/** Inverse of `toWorld`. Needed to turn a drag in pixels back into a centre. */
export function fromWorld(world: { x: number; y: number }): LatLng {
	const n = Math.PI * (1 - 2 * world.y);
	return {
		lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
		lng: world.x * 360 - 180,
	};
}

/**
 * The largest integer zoom at which `bounds` still fits inside `width`×`height`.
 *
 * Integer rather than fractional because tiles only exist at integer zooms;
 * a fractional zoom would mean scaling tiles and taking the blur for no gain
 * at the sizes involved here.
 */
export function fitZoom(bounds: BoundingBox, width: number, height: number, padding = 0): number {
	const nw = toWorld({ lat: bounds.maxLat, lng: bounds.minLng });
	const se = toWorld({ lat: bounds.minLat, lng: bounds.maxLng });

	// Guard the degenerate single-point box: no span means no constraint, so
	// fall back to a close-in street zoom rather than dividing by zero.
	const spanX = Math.abs(se.x - nw.x);
	const spanY = Math.abs(se.y - nw.y);
	if (spanX < 1e-12 && spanY < 1e-12) return 16;

	const innerW = Math.max(width - padding * 2, 1);
	const innerH = Math.max(height - padding * 2, 1);

	const zoomX = spanX > 0 ? Math.log2(innerW / (spanX * TILE_SIZE)) : MAX_ZOOM;
	const zoomY = spanY > 0 ? Math.log2(innerH / (spanY * TILE_SIZE)) : MAX_ZOOM;

	return clamp(Math.floor(Math.min(zoomX, zoomY)), MIN_ZOOM, MAX_ZOOM);
}

export function boundsCentre(bounds: BoundingBox): LatLng {
	// Averaged in world space, not lat/lng space: Mercator's y is non-linear in
	// latitude, so a lat midpoint is not the midpoint of the rendered map.
	const nw = toWorld({ lat: bounds.maxLat, lng: bounds.minLng });
	const se = toWorld({ lat: bounds.minLat, lng: bounds.maxLng });
	return fromWorld({ x: (nw.x + se.x) / 2, y: (nw.y + se.y) / 2 });
}

export interface Viewport {
	centre: LatLng;
	zoom: number;
	width: number;
	height: number;
}

export interface MapView {
	/** lat/lng → pixel coordinates within the viewport. */
	project(point: LatLng): { x: number; y: number };
	/** Pixel coordinates within the viewport → lat/lng. */
	unproject(pixel: { x: number; y: number }): LatLng;
	/** The tiles covering this viewport, already positioned. */
	tiles: TilePlacement[];
	zoom: number;
	width: number;
	height: number;
}

export interface TilePlacement {
	z: number;
	x: number;
	y: number;
	/** Top-left offset within the viewport, in pixels. */
	left: number;
	top: number;
	/** Stable key for keyed each-blocks, so panning reuses loaded <image>
	 *  elements instead of tearing them down and refetching. */
	key: string;
}

export function createMapView(viewport: Viewport): MapView {
	const { centre, zoom, width, height } = viewport;
	const scale = TILE_SIZE * Math.pow(2, zoom);
	const centreWorld = toWorld(centre);

	// Pixel coordinates of the viewport's top-left corner in the whole world.
	const originX = centreWorld.x * scale - width / 2;
	const originY = centreWorld.y * scale - height / 2;

	const tileCount = Math.pow(2, zoom);

	const firstX = Math.floor(originX / TILE_SIZE);
	const lastX = Math.floor((originX + width) / TILE_SIZE);
	const firstY = Math.floor(originY / TILE_SIZE);
	const lastY = Math.floor((originY + height) / TILE_SIZE);

	const tiles: TilePlacement[] = [];
	for (let ty = firstY; ty <= lastY; ty++) {
		// No vertical wrap — above the north edge or below the south there is
		// simply no tile, and requesting one is a guaranteed 404.
		if (ty < 0 || ty >= tileCount) continue;
		for (let tx = firstX; tx <= lastX; tx++) {
			// Horizontal wrap is real: pan far enough east and you come back
			// round. Modulo keeps the request valid.
			const wrappedX = ((tx % tileCount) + tileCount) % tileCount;
			tiles.push({
				z: zoom,
				x: wrappedX,
				y: ty,
				left: tx * TILE_SIZE - originX,
				top: ty * TILE_SIZE - originY,
				key: `${zoom}/${wrappedX}/${ty}/${tx}`,
			});
		}
	}

	return {
		zoom,
		width,
		height,
		tiles,
		project(point: LatLng) {
			const world = toWorld(point);
			return { x: world.x * scale - originX, y: world.y * scale - originY };
		},
		unproject(pixel: { x: number; y: number }) {
			return fromWorld({
				x: (pixel.x + originX) / scale,
				y: (pixel.y + originY) / scale,
			});
		},
	};
}

/** Metres per pixel at a given latitude and zoom — the scale bar's basis. */
export function metresPerPixel(lat: number, zoom: number): number {
	const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
	return (
		(EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * Math.pow(2, zoom))
	);
}

/**
 * Basemap tile source.
 *
 * CARTO Positron: keyless, light enough that coloured turf polygons stay
 * legible on top, and — unlike tile.openstreetmap.org — not served under a
 * usage policy that forbids exactly this. Attribution to both CARTO and
 * OpenStreetMap is a condition of use and is rendered on the map, not
 * buried in a tooltip.
 *
 * Before this carries real volunteer traffic, move to a keyed account with a
 * contract behind it (CARTO, Stadia, Protomaps, or self-hosted). Keyless
 * endpoints are courtesy, not an SLA, and a canvass launch is the worst
 * possible moment to discover you have been rate-limited. That swap is this
 * one constant.
 */
export const TILE_URL_TEMPLATE = 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png';

export const TILE_ATTRIBUTION = '© OpenStreetMap contributors © CARTO';

export function tileUrl(tile: TilePlacement, template = TILE_URL_TEMPLATE): string {
	return template
		.replace('{z}', String(tile.z))
		.replace('{x}', String(tile.x))
		.replace('{y}', String(tile.y));
}

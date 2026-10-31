// Drawing for the signed-out /turfs teaser: the blurred turf density layer
// and the canvasser dots that wander over it.
//
// Kept out of the component so the component stays about layout, and so the
// dot simulation can be read (and tested) on its own. Everything here works in
// screen pixels; the component projects cells to the screen before calling in.
//
// The dots are decoration, not data. Their count comes from the canvasser
// LEVEL the server sent, never a head-count, and every position is invented:
// a dot starts on a random turf cell and wanders. None of them is anyone.

import { CANVASSER_LEVELS, GRID_RADIUS_MILES, NEARBY_RADIUS_MILES } from './nearby-summary.js';

export interface ScreenCell {
	x: number;
	y: number;
	w: 1 | 2 | 3 | 4;
}

/** Fill strength per weight, matching the available-turf ramp on the real map
 *  (turf-page.css), then scaled down because neighbouring blobs overlap. */
const WEIGHT_ALPHA = [0, 0.28, 0.42, 0.56, 0.7].map((a) => a * 0.55);

/**
 * Paint each cell as a soft round blob. Squares would leave their corners
 * showing through the blur wherever neighbouring cells differ; blobs have no
 * corners to show. The blur itself is a CSS filter on the canvas.
 */
export function drawDensity(
	ctx: CanvasRenderingContext2D,
	cells: readonly ScreenCell[],
	cellPx: number,
	color: string,
): void {
	const r = cellPx * 1.15;
	for (const cell of cells) {
		const g = ctx.createRadialGradient(cell.x, cell.y, 0, cell.x, cell.y, r);
		g.addColorStop(0, color);
		g.addColorStop(0.55, color);
		g.addColorStop(1, 'transparent');
		ctx.globalAlpha = WEIGHT_ALPHA[cell.w]!;
		ctx.fillStyle = g;
		ctx.fillRect(cell.x - r, cell.y - r, r * 2, r * 2);
	}
	ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Canvasser dots
// ---------------------------------------------------------------------------

/** The dots roam the whole grid, not just the ring. To keep the ring's density
 *  matching the level, the count is scaled by how much bigger that area is. */
const AREA_FACTOR = (GRID_RADIUS_MILES / NEARBY_RADIUS_MILES) ** 2;

/** Dots on screen for a canvasser level. */
export function dotsForLevel(level: number): number {
	const dots = CANVASSER_LEVELS[level]?.dots ?? 0;
	return Math.round(dots * AREA_FACTOR);
}

export interface Walker {
	x: number;
	y: number;
	heading: number;
	turn: number;
	trail: [number, number][];
	born: number;
}

export interface Field {
	/** The visitor's point on screen. */
	cx: number;
	cy: number;
	pxPerMile: number;
	width: number;
	height: number;
	cells: readonly ScreenCell[];
	cellPx: number;
}

const TRAIL_LENGTH = 36;
const EDGE_MARGIN_MILES = 0.25;
/** Walking pace off turf and on it, in miles per second of animation. Slow on
 *  turf so the dots look like they stop to knock. */
const SPEED_OFF_TURF = 0.045;
const SPEED_ON_TURF = 0.018;

function inBounds(field: Field, x: number, y: number, marginPx: number): boolean {
	const roam = GRID_RADIUS_MILES * field.pxPerMile - marginPx;
	return (
		Math.hypot(x - field.cx, y - field.cy) <= roam &&
		x >= marginPx &&
		x <= field.width - marginPx &&
		y >= marginPx &&
		y <= field.height - marginPx
	);
}

function spawnPoint(field: Field, rand: () => number): { x: number; y: number } {
	const margin = 0.2 * field.pxPerMile;
	const candidates = field.cells.filter((c) => inBounds(field, c.x, c.y, margin));
	const total = candidates.reduce((sum, c) => sum + c.w, 0);
	if (total > 0) {
		let pick = rand() * total;
		for (const c of candidates) {
			pick -= c.w;
			if (pick <= 0) {
				return {
					x: c.x + (rand() - 0.5) * field.cellPx * 0.8,
					y: c.y + (rand() - 0.5) * field.cellPx * 0.8,
				};
			}
		}
	}
	// No turf on screen: anywhere inside the ring.
	const a = rand() * Math.PI * 2;
	const r = Math.sqrt(rand()) * (NEARBY_RADIUS_MILES - 0.2) * field.pxPerMile;
	return { x: field.cx + Math.cos(a) * r, y: field.cy + Math.sin(a) * r };
}

/** Grow or shrink `walkers` to `count`, spawning new dots on turf. */
export function syncWalkers(
	walkers: Walker[],
	count: number,
	field: Field,
	now: number,
	rand: () => number = Math.random,
): void {
	while (walkers.length < count) {
		const p = spawnPoint(field, rand);
		walkers.push({ ...p, heading: rand() * Math.PI * 2, turn: 0, trail: [], born: now });
	}
	if (walkers.length > count) walkers.length = count;
}

function onTurf(field: Field, x: number, y: number): boolean {
	const reach = field.cellPx * 0.6;
	return field.cells.some((c) => Math.abs(c.x - x) <= reach && Math.abs(c.y - y) <= reach);
}

/** Advance every dot by `dt` seconds. */
export function stepWalkers(
	walkers: Walker[],
	field: Field,
	dt: number,
	rand: () => number = Math.random,
): void {
	const margin = EDGE_MARGIN_MILES * field.pxPerMile;
	for (const w of walkers) {
		// The turn rate drifts smoothly, so paths curve rather than jitter.
		w.turn += (rand() - 0.5) * 2.4 * dt;
		w.turn *= Math.pow(0.35, dt);
		w.heading += w.turn * dt;
		// Near an edge, steer back toward the visitor's point.
		if (!inBounds(field, w.x, w.y, margin)) {
			const home = Math.atan2(field.cy - w.y, field.cx - w.x);
			const diff = ((home - w.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
			w.heading += diff * Math.min(1, dt * 1.5);
		}
		const milesPerSecond = onTurf(field, w.x, w.y) ? SPEED_ON_TURF : SPEED_OFF_TURF;
		const step = milesPerSecond * field.pxPerMile * dt;
		w.x += Math.cos(w.heading) * step;
		w.y += Math.sin(w.heading) * step;
		w.trail.push([w.x, w.y]);
		if (w.trail.length > TRAIL_LENGTH) w.trail.shift();
	}
}

/** Paint the dots: a fading trail, then a filled dot with an outline. New dots
 *  fade in so a level change does not pop. */
export function drawWalkers(
	ctx: CanvasRenderingContext2D,
	walkers: readonly Walker[],
	colors: { fill: string; edge: string },
	now: number,
): void {
	ctx.lineCap = 'round';
	for (const w of walkers) {
		const alpha = Math.min(1, Math.max(0, (now - w.born) / 800));
		if (w.trail.length > 1) {
			ctx.globalAlpha = alpha * 0.35;
			ctx.strokeStyle = colors.fill;
			ctx.lineWidth = 2;
			ctx.beginPath();
			w.trail.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
			ctx.stroke();
		}
		ctx.globalAlpha = alpha;
		ctx.fillStyle = colors.fill;
		ctx.beginPath();
		ctx.arc(w.x, w.y, 5.5, 0, Math.PI * 2);
		ctx.fill();
		ctx.lineWidth = 2;
		ctx.strokeStyle = colors.edge;
		ctx.stroke();
	}
	ctx.globalAlpha = 1;
}

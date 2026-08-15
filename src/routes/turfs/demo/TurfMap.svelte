<script lang="ts">
	// Turf hulls over a real street basemap, with no mapping library.
	//
	// The projection and tile grid are ours ($lib/van/tiles, unit-tested); this
	// file is the pointer, keyboard and rendering layer on top. Leaflet (~42 KB
	// + stylesheet + an SSR guard for its window access) would supply all of it,
	// and the honest accounting of what we gave up is:
	//
	//   - fractional zoom. Ours snaps to integer levels, because tiles only
	//     exist at integer zooms and scaling bitmaps means blur.
	//   - tile retention during a zoom. Leaflet keeps the old layer underneath
	//     while the new one loads; we swap and briefly show the graticule.
	//   - tile prefetch beyond the viewport, so ours pop in at the edges.
	//   - inertial panning, and a marker/popup API this page doesn't use.
	//
	// What we kept: no dependency, no SSR dance, one coordinate system shared
	// with geometry.ts, and pure functions we can unit-test. If the steppy zoom
	// starts drawing complaints from volunteers, swapping in Leaflet replaces
	// THIS FILE and nothing else — that boundary is the point.
	//
	// Tiles are CARTO Positron: keyless, light enough that coloured polygons
	// stay legible, and not under a usage policy that forbids this. Attribution
	// is a condition of use and is rendered, not hidden.

	import {
		boundingBox,
		boundsForNearest,
		padBounds,
		unionBounds,
		type BoundingBox,
		type LatLng,
	} from '$lib/van/geometry.js';
	import {
		boundsCentre,
		createMapView,
		fitZoom,
		metresPerPixel,
		MAX_ZOOM,
		MIN_ZOOM,
		TILE_ATTRIBUTION,
		TILE_SIZE,
		tileUrl,
	} from '$lib/van/tiles.js';
	import { statusLabel, type VolunteerStatus } from '$lib/van/turf-status.js';
	import type { DemoTurf } from './demo-turfs.js';

	interface Props {
		turfs: DemoTurf[];
		selectedId: number | null;
		location: LatLng;
		onselect: (mapRouteId: number) => void;
	}

	let { turfs, selectedId, location, onselect }: Props = $props();

	const WIDTH = 720;
	const HEIGHT = 520;
	const PADDING = 32;

	/** How many nearby turfs the opening view frames. Chapters run to ~150
	 *  miles across while a turf is a couple of miles, so fitting the whole
	 *  chapter would render every turf at a few pixels and answer a question
	 *  nobody asked. Open on the volunteer's neighbourhood; "Show all" is one
	 *  click away. */
	const NEARBY_COUNT = 5;

	/** Below this projected size a hull is a smudge, so it draws as a pin
	 *  instead. This is what keeps turfs findable when someone zooms out to
	 *  survey a whole county. */
	const PIN_BELOW_PX = 16;

	/** Above this projected size there's room for a turf number. Higher than
	 *  PIN_BELOW_PX because a 20px polygon can be drawn but not labelled. */
	const LABEL_ABOVE_PX = 34;

	const nearbyBounds = $derived(padBounds(boundsForNearest(location, turfs, NEARBY_COUNT), 0.15));

	const allBounds = $derived.by(() => {
		const boxes = turfs.map((t) => t.bounds);
		boxes.push(boundingBox([location])!);
		return padBounds(unionBounds(boxes) ?? nearbyBounds, 0.1);
	});

	// Camera. Seeded from the fit, then owned by the user once they pan or
	// zoom — `moved` is what stops a re-render from yanking the view back.
	let moved = $state(false);
	let centre = $state<LatLng | null>(null);
	let zoom = $state<number | null>(null);

	const view = $derived(
		createMapView({
			centre: centre ?? boundsCentre(nearbyBounds),
			zoom: zoom ?? fitZoom(nearbyBounds, WIDTH, HEIGHT, PADDING),
			width: WIDTH,
			height: HEIGHT,
		}),
	);

	function frameTo(bounds: BoundingBox) {
		centre = boundsCentre(bounds);
		zoom = fitZoom(bounds, WIDTH, HEIGHT, PADDING);
		moved = true;
	}

	const me = $derived(view.project(location));

	/** Tiles that failed to load — a dead provider must not leave a white void
	 *  with no explanation, so the graticule and this flag stay behind them. */
	let failedTiles = $state<Record<string, boolean>>({});
	const tilesBroken = $derived(
		view.tiles.length > 0 && view.tiles.every((t) => failedTiles[t.key]),
	);

	/** "Ward 3 Turf 01" → "01". The card carries the full name; the map only
	 *  needs to tell neighbours apart. */
	function shortLabel(name: string): string {
		return name.match(/(\d+)\s*$/)?.[1] ?? name;
	}

	interface RenderedTurf {
		turf: DemoTurf;
		/** Pin/label position — the projected door centroid. */
		x: number;
		y: number;
		/** Polygon points, or null when the turf draws as a pin. */
		points: string | null;
		/** Null when there is no room to read a number. */
		label: string | null;
	}

	/**
	 * Everything the map draws, computed once per view change.
	 *
	 * Two things happen here that matter at scale, and a chapter can hold a
	 * thousand turfs:
	 *
	 * 1. **Culling.** Turfs outside the viewport are dropped before any hull is
	 *    projected. Zoomed into a neighbourhood this is the difference between
	 *    projecting twenty thousand points per drag frame and projecting a few
	 *    hundred.
	 * 2. **One pass.** Projection, pin-vs-polygon and labelling are decided
	 *    together instead of in three functions each re-projecting the same
	 *    bounds from the template.
	 */
	const rendered = $derived.by((): RenderedTurf[] => {
		// A margin keeps turfs that straddle the edge from popping in and out.
		const margin = 64;
		const out: RenderedTurf[] = [];

		for (const turf of turfs) {
			const nw = view.project({ lat: turf.bounds.maxLat, lng: turf.bounds.minLng });
			const se = view.project({ lat: turf.bounds.minLat, lng: turf.bounds.maxLng });

			if (se.x < -margin || nw.x > WIDTH + margin) continue;
			if (se.y < -margin || nw.y > HEIGHT + margin) continue;

			const size = Math.max(Math.abs(se.x - nw.x), Math.abs(se.y - nw.y));
			const centrePoint = view.project(turf.centre);
			const asPin = turf.hull.length < 3 || size < PIN_BELOW_PX;

			out.push({
				turf,
				x: centrePoint.x,
				y: centrePoint.y,
				points: asPin
					? null
					: turf.hull
							.map((p) => view.project(p))
							.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
							.join(' '),
				label: size >= LABEL_ABOVE_PX ? shortLabel(turf.name) : null,
			});
		}
		return out;
	});

	// --- Panning and pinching -----------------------------------------------
	// Pointer events rather than mouse+touch: one code path covers mouse, pen
	// and finger, and setPointerCapture keeps a gesture alive when the cursor
	// leaves the svg mid-drag.
	//
	// `touch-action: none` in the stylesheet suppresses the browser's own pan
	// and pinch, which means we owe the user a replacement for BOTH. One finger
	// pans; two fingers pinch. Volunteers use this standing on a pavement, so
	// pinch is not a nicety — without it a phone can only zoom via the +/−
	// buttons.

	let dragging = $state(false);
	let dragMoved = false;
	let dragOrigin = { x: 0, y: 0 };

	interface ActivePointer {
		id: number;
		x: number;
		y: number;
	}

	/** Live pointers. Two of them means a pinch is in progress.
	 *
	 *  A plain array, not $state and not a SvelteMap: nothing renders from it,
	 *  it only feeds the gesture arithmetic below, and making it reactive would
	 *  schedule an update on every pointermove for no visible change. */
	let activePointers: ActivePointer[] = [];

	/** Gesture baseline, captured when the second finger lands. */
	let pinch: { distance: number; zoom: number } | null = null;

	function trackPointer(event: PointerEvent) {
		const existing = activePointers.find((p) => p.id === event.pointerId);
		if (existing) {
			existing.x = event.clientX;
			existing.y = event.clientY;
		} else {
			activePointers.push({ id: event.pointerId, x: event.clientX, y: event.clientY });
		}
	}

	function pointerPair(): [ActivePointer, ActivePointer] | null {
		return activePointers.length === 2 ? [activePointers[0], activePointers[1]] : null;
	}

	function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
		return Math.hypot(a.x - b.x, a.y - b.y);
	}

	function onPointerDown(event: PointerEvent) {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		trackPointer(event);
		(event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);

		const pair = pointerPair();
		if (pair) {
			// Second finger down: stop panning, start pinching.
			dragging = false;
			pinch = { distance: distanceBetween(pair[0], pair[1]), zoom: view.zoom };
			return;
		}

		dragging = true;
		dragMoved = false;
		dragOrigin = { x: event.clientX, y: event.clientY };
	}

	function onPointerMove(event: PointerEvent) {
		if (!activePointers.some((p) => p.id === event.pointerId)) return;
		trackPointer(event);

		const svg = event.currentTarget as SVGSVGElement;
		const pair = pointerPair();

		if (pair && pinch) {
			const distance = distanceBetween(pair[0], pair[1]);
			if (distance < 20 || pinch.distance < 20) return; // fingers too close to be stable

			// Continuous pinch scale, snapped to the nearest integer zoom.
			// Tiles only exist at integer zooms, so a fractional zoom would mean
			// scaling bitmaps and taking the blur; snapping keeps them crisp and
			// still tracks the gesture closely enough to feel connected.
			const target = pinch.zoom + Math.log2(distance / pinch.distance);
			const next = Math.round(target);
			if (next !== view.zoom) {
				const midpoint = {
					clientX: (pair[0].x + pair[1].x) / 2,
					clientY: (pair[0].y + pair[1].y) / 2,
				};
				changeZoom(next - view.zoom, toViewBox(midpoint, svg));
			}
			dragMoved = true;
			return;
		}

		if (!dragging) return;
		const dx = event.clientX - dragOrigin.x;
		const dy = event.clientY - dragOrigin.y;
		if (Math.abs(dx) + Math.abs(dy) < 3) return;

		// The svg is scaled to its container, so a client-pixel delta is not a
		// viewBox-unit delta. Convert through the rendered width.
		const unitsPerPixel = WIDTH / svg.getBoundingClientRect().width;

		dragMoved = true;
		// Dragging right moves the map right, i.e. the centre moves left.
		centre = view.unproject({
			x: WIDTH / 2 - dx * unitsPerPixel,
			y: HEIGHT / 2 - dy * unitsPerPixel,
		});
		zoom = view.zoom;
		moved = true;
		dragOrigin = { x: event.clientX, y: event.clientY };
	}

	function onPointerUp(event: PointerEvent) {
		activePointers = activePointers.filter((p) => p.id !== event.pointerId);
		(event.currentTarget as SVGSVGElement).releasePointerCapture?.(event.pointerId);

		if (activePointers.length < 2) pinch = null;

		// Lifting one finger of a pinch leaves the other still down. Resume
		// panning from where it actually is, or the map jumps by the distance
		// between the two fingers.
		const [remaining] = activePointers;
		if (remaining) {
			dragging = true;
			dragOrigin = { x: remaining.x, y: remaining.y };
		} else {
			dragging = false;
		}
	}

	// --- Keyboard -----------------------------------------------------------
	// Without this the map is mouse-and-touch only, which fails anyone using a
	// keyboard and anyone whose pointing device is imprecise. Arrows pan by a
	// quarter-viewport, +/− zoom, Home refits.

	function onKeyDown(event: KeyboardEvent) {
		const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
			event.key
		];

		if (step) {
			event.preventDefault(); // otherwise the page scrolls instead
			centre = view.unproject({
				x: WIDTH / 2 + step[0] * (WIDTH / 4),
				y: HEIGHT / 2 + step[1] * (HEIGHT / 4),
			});
			zoom = view.zoom;
			moved = true;
			return;
		}

		if (event.key === '+' || event.key === '=') {
			event.preventDefault();
			changeZoom(1);
		} else if (event.key === '-' || event.key === '_') {
			event.preventDefault();
			changeZoom(-1);
		} else if (event.key === 'Home') {
			event.preventDefault();
			resetView();
		}
	}

	/** Zoom by `delta`, holding `anchor` (viewport pixels) still.
	 *
	 *  Anchoring matters far more here than on a typical map: going from a
	 *  county overview to a single turf is six or seven zoom levels, and
	 *  centre-only zoom loses whatever you were aiming at within two of them.
	 *  Defaults to the middle, which is what the +/− buttons want. */
	function changeZoom(delta: number, anchor = { x: WIDTH / 2, y: HEIGHT / 2 }) {
		const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom + delta));
		if (nextZoom === view.zoom) return;

		const held = view.unproject(anchor);
		const currentCentre = view.unproject({ x: WIDTH / 2, y: HEIGHT / 2 });

		// Re-project the held point at the new zoom, then shift the centre by
		// however far it drifted.
		const probe = createMapView({
			centre: currentCentre,
			zoom: nextZoom,
			width: WIDTH,
			height: HEIGHT,
		});
		const after = probe.project(held);
		centre = probe.unproject({
			x: WIDTH / 2 + (after.x - anchor.x),
			y: HEIGHT / 2 + (after.y - anchor.y),
		});
		zoom = nextZoom;
		moved = true;
	}

	/** Client coordinates → viewBox units. The svg is scaled to its container,
	 *  so these are not the same thing. */
	function toViewBox(event: { clientX: number; clientY: number }, el: SVGSVGElement) {
		const rect = el.getBoundingClientRect();
		return {
			x: ((event.clientX - rect.left) / rect.width) * WIDTH,
			y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
		};
	}

	// Trackpads emit a stream of small deltas; one zoom level per event would
	// fly from a county to a doorstep on a single flick. Accumulate instead.
	let wheelAccumulator = 0;
	const WHEEL_STEP = 120;

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		wheelAccumulator += event.deltaY;
		const steps = Math.trunc(wheelAccumulator / WHEEL_STEP);
		if (steps === 0) return;
		wheelAccumulator -= steps * WHEEL_STEP;
		changeZoom(-steps, toViewBox(event, event.currentTarget as SVGSVGElement));
	}

	function resetView() {
		centre = null;
		zoom = null;
		moved = false;
	}

	/** A click that ended a drag is not a selection. */
	function selectIfNotDragging(mapRouteId: number) {
		if (dragMoved) return;
		onselect(mapRouteId);
	}

	// --- Scale bar ----------------------------------------------------------

	const scale = $derived.by(() => {
		const mpp = metresPerPixel(view.unproject({ x: WIDTH / 2, y: HEIGHT / 2 }).lat, view.zoom);
		const target = WIDTH / 4;
		const choice = [2000, 1000, 500, 250, 100, 50].find((m) => m / mpp <= target) ?? 50;
		return {
			px: choice / mpp,
			label: choice >= 1000 ? `${choice / 1000} km` : `${choice} m`,
		};
	});

	/** True when at least one turf is off-screen — the only time offering
	 *  "Show all" is meaningful. Falls out of the cull for free. */
	const hasOffscreenTurfs = $derived(rendered.length < turfs.length);

	function statusClass(turf: DemoTurf): string {
		return `turf turf-${turf.status}${turf.mapRouteId === selectedId ? ' is-selected' : ''}`;
	}

	function ariaLabelFor(turf: DemoTurf): string {
		const doors = turf.status === 'available' ? `, ${turf.doorsRemaining} doors remaining` : '';
		return `${turf.name}, ${statusLabel(turf.status as VolunteerStatus)}${doors}`;
	}
</script>

<figure class="map-figure">
	<div class="map-frame">
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<!-- Svelte's a11y heuristics don't model a map widget: it treats <svg> as
		     non-interactive regardless of role, so a focusable, keyboard-driven
		     map trips both rules. `role="application"` with a tabindex and key
		     handlers is the correct ARIA pattern here — it tells a screen reader
		     to pass arrow keys through to us rather than using them to navigate
		     — and every mapping library does the same thing. Suppressed
		     deliberately, not because the rules are noisy. -->
		<svg
			viewBox="0 0 {WIDTH} {HEIGHT}"
			class="turf-map"
			class:is-dragging={dragging}
			role="application"
			tabindex="0"
			aria-label="Map of canvassing turfs near you. Arrow keys pan, plus and minus zoom, Home resets."
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
			onwheel={onWheel}
			onkeydown={onKeyDown}
		>
			<defs>
				<!-- Behind the tiles, so a provider outage degrades to a grid with a
				     message rather than a blank white rectangle. -->
				<pattern id="graticule" width="40" height="40" patternUnits="userSpaceOnUse">
					<path
						d="M40 0 L0 0 0 40"
						fill="none"
						stroke="var(--color-border-subtle)"
						stroke-width="1"
					/>
				</pattern>
				<clipPath id="map-clip">
					<rect width={WIDTH} height={HEIGHT} />
				</clipPath>
			</defs>

			<rect width={WIDTH} height={HEIGHT} fill="url(#graticule)" />

			<g clip-path="url(#map-clip)">
				<g class="basemap">
					{#each view.tiles as tile (tile.key)}
						<image
							href={tileUrl(tile)}
							x={tile.left}
							y={tile.top}
							width={TILE_SIZE}
							height={TILE_SIZE}
							onerror={() => (failedTiles[tile.key] = true)}
						/>
					{/each}
				</g>

				{#each rendered as item (item.turf.mapRouteId)}
					<g
						class={statusClass(item.turf)}
						role="button"
						aria-label={ariaLabelFor(item.turf)}
						aria-pressed={item.turf.mapRouteId === selectedId}
						tabindex={item.points ? 0 : -1}
						onclick={() => selectIfNotDragging(item.turf.mapRouteId)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onselect(item.turf.mapRouteId);
							}
						}}
					>
						{#if item.points}
							<polygon points={item.points} />
						{:else}
							<!-- Too small to read as a shape, or a degenerate hull
							     (collinear doors, or too few). Either way: a pin, never a
							     zero-area sliver. Not a tab stop — zoomed out over a county
							     that would be hundreds of them between the map and the next
							     control, and the turf list beside the map is the keyboard
							     path anyway. -->
							<circle cx={item.x} cy={item.y} r="7" />
						{/if}
						{#if item.label}
							<text x={item.x} y={item.y} text-anchor="middle" dominant-baseline="central">
								{item.label}
							</text>
						{/if}
					</g>
				{/each}

				<g class="me" aria-hidden="true">
					<circle class="me-halo" cx={me.x} cy={me.y} r="16" />
					<circle class="me-dot" cx={me.x} cy={me.y} r="6" />
				</g>
			</g>

			<g class="scale-bar" aria-hidden="true">
				<line x1={PADDING} y1={HEIGHT - 20} x2={PADDING + scale.px} y2={HEIGHT - 20} />
				<line x1={PADDING} y1={HEIGHT - 25} x2={PADDING} y2={HEIGHT - 15} />
				<line x1={PADDING + scale.px} y1={HEIGHT - 25} x2={PADDING + scale.px} y2={HEIGHT - 15} />
				<text x={PADDING + scale.px / 2} y={HEIGHT - 29} text-anchor="middle">{scale.label}</text>
			</g>
		</svg>

		<div class="map-controls">
			<button type="button" onclick={() => changeZoom(1)} aria-label="Zoom in">+</button>
			<button type="button" onclick={() => changeZoom(-1)} aria-label="Zoom out">−</button>
			{#if moved}
				<button type="button" class="wide" onclick={resetView}>Near me</button>
			{/if}
			{#if hasOffscreenTurfs}
				<button type="button" class="wide" onclick={() => frameTo(allBounds)}>Show all</button>
			{/if}
		</div>

		<p class="attribution">{TILE_ATTRIBUTION}</p>

		{#if tilesBroken}
			<p class="tile-error" role="status">
				Street map unavailable — turf shapes and positions are still accurate.
			</p>
		{/if}
	</div>

	<figcaption>
		Drag to pan, pinch or scroll to zoom. With the map focused, arrow keys pan and
		<kbd>+</kbd>/<kbd>−</kbd> zoom. Turfs too small to draw at this zoom show as dots. Shapes are convex
		hulls over each turf's doors, so they claim a little more ground than the turf really covers — MiniVAN
		is the authority on which doors are on your list.
	</figcaption>
</figure>

<style>
	.map-figure {
		margin: 0;
	}

	.map-frame {
		position: relative;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		background: var(--color-surface);
	}

	.turf-map {
		display: block;
		width: 100%;
		height: auto;
		cursor: grab;
		touch-action: none;
	}

	.turf-map.is-dragging {
		cursor: grabbing;
	}

	/* The map is keyboard-operable, so it must show where focus is. */
	.turf-map:focus-visible {
		outline: 3px solid var(--color-border-focus);
		outline-offset: -3px;
	}

	figcaption kbd {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.95em;
		padding: 0 3px;
		border: 1px solid var(--color-border);
		border-radius: 3px;
		background: var(--color-cream-light);
	}

	.basemap image {
		/* Kills the hairline seams between adjacent tiles on fractional offsets. */
		shape-rendering: crispEdges;
		/* Tiles are scenery. Without this the browser's native image drag wins
		   the gesture and the map stops panning halfway through a swipe. */
		pointer-events: none;
		-webkit-user-drag: none;
	}

	.turf-map {
		/* Same reason: a drag that starts on a label must pan, not select text. */
		user-select: none;
		-webkit-user-select: none;
	}

	figcaption {
		margin-top: 8px;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
		line-height: 1.5;
	}

	.map-controls {
		position: absolute;
		top: 10px;
		right: 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.map-controls button {
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		background: var(--color-surface);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		font-size: 1.1rem;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
	}

	.map-controls button:hover {
		background: var(--color-cream-light);
		border-color: var(--color-action);
	}

	.map-controls .wide {
		width: auto;
		padding: 0 8px;
		font-size: var(--font-size-xs);
		font-weight: 600;
		white-space: nowrap;
	}

	.attribution {
		position: absolute;
		right: 0;
		bottom: 0;
		margin: 0;
		padding: 2px 6px;
		background: rgb(255 255 255 / 0.75);
		border-top-left-radius: var(--radius-sm);
		font-size: 10px;
		color: var(--color-warm-dark);
	}

	.tile-error {
		position: absolute;
		left: 50%;
		top: 12px;
		transform: translateX(-50%);
		margin: 0;
		padding: 6px 12px;
		background: var(--color-surface);
		border: 1px solid var(--color-warning);
		border-radius: var(--radius-md);
		font-size: var(--font-size-xs);
		color: var(--color-text);
	}

	.turf {
		cursor: pointer;
	}

	.turf polygon,
	.turf circle {
		stroke-width: 2;
		transition: fill-opacity 120ms ease;
	}

	.turf text {
		font-size: 13px;
		font-weight: 700;
		fill: #fff;
		paint-order: stroke;
		stroke: rgb(0 0 0 / 0.45);
		stroke-width: 3px;
		pointer-events: none;
		user-select: none;
	}

	.turf:hover polygon,
	.turf:hover circle {
		fill-opacity: 0.8;
	}

	.turf:focus-visible {
		outline: none;
	}

	.turf:focus-visible polygon,
	.turf:focus-visible circle {
		stroke: var(--color-border-focus);
		stroke-width: 4;
	}

	.turf.is-selected polygon,
	.turf.is-selected circle {
		stroke: var(--color-near-black);
		stroke-width: 4;
		fill-opacity: 0.85;
	}

	/* Available turf is the only thing a volunteer can act on, so it is the only
	   saturated colour; taken turf recedes into the map. Opacities run higher
	   than they would on a blank background — there are streets underneath now,
	   and a 0.3 fill over a basemap reads as noise. */
	.turf-available polygon,
	.turf-available circle {
		fill: var(--color-blue);
		fill-opacity: 0.62;
		stroke: var(--color-navy-mid);
	}

	.turf-held-by-you polygon,
	.turf-held-by-you circle {
		fill: var(--color-success);
		fill-opacity: 0.65;
		stroke: #1a6b3c;
	}

	.turf-checked-out polygon,
	.turf-checked-out circle {
		fill: var(--color-warm-dark);
		fill-opacity: 0.42;
		stroke: var(--color-warm-dark);
	}

	.me-dot {
		fill: var(--color-coral);
		stroke: #fff;
		stroke-width: 2.5;
	}

	.me-halo {
		fill: var(--color-coral);
		fill-opacity: 0.2;
	}

	.scale-bar line {
		stroke: var(--color-near-black);
		stroke-width: 1.5;
	}

	.scale-bar text {
		font-size: 11px;
		font-weight: 600;
		fill: var(--color-near-black);
		paint-order: stroke;
		stroke: rgb(255 255 255 / 0.85);
		stroke-width: 3px;
	}

	@media (prefers-reduced-motion: reduce) {
		.turf polygon,
		.turf circle {
			transition: none;
		}
	}
</style>

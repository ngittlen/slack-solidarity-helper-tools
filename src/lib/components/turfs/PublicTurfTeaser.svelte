<script lang="ts">
	// The signed-out face of /turfs: a blurred map of the turf around a place
	// the visitor gives us, with three coarse numbers and a way into the Slack.
	//
	// Everything drawn here is already coarse when it arrives — see
	// $lib/van/nearby-summary.ts. The blur is for looks, not for privacy: the
	// payload carries no hull, turf or head-count to un-blur. The dots are
	// invented positions, sized from the canvasser LEVEL.

	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { LatLng } from '$lib/van/geometry.js';
	import { createMapView, metresPerPixel, tileUrl, MAX_ZOOM, MIN_ZOOM } from '$lib/van/tiles.js';
	import {
		CANVASSER_LEVELS,
		CELL_MILES,
		METRES_PER_MILE,
		NEARBY_RADIUS_MILES,
		placeLabel,
		type DensityCell,
		type DoorsHeadline,
		type NearbyPlace,
	} from '$lib/van/nearby-summary.js';
	import {
		dotsForLevel,
		drawDensity,
		drawWalkers,
		stepWalkers,
		syncWalkers,
		type Field,
		type ScreenCell,
		type Walker,
	} from '$lib/van/teaser-canvas.js';

	interface Nearby {
		centre: LatLng;
		doors: DoorsHeadline;
		canvassers: number;
		cells: DensityCell[];
		place: NearbyPlace;
	}

	interface Props {
		tiles: { urlTemplate: string; attribution: string };
		/** Where to point the map before a lookup. Null when there is no turf. */
		turfCentre: LatLng | null;
		/** The "Join our chat" link from settings; null hides the button. */
		joinUrl: string | null;
		signInHref: string;
		/** The last lookup's answer, from the `nearby` action. */
		nearby: Nearby | null;
		/** The last lookup's refusal, from the `nearby` action. */
		error: string | null;
	}

	let { tiles, turfCentre, joinUrl, signInHref, nearby, error }: Props = $props();

	// Measured, with a desktop-sized fallback for the server render.
	let width = $state(0);
	let height = $state(0);
	const mapWidth = $derived(width || 1024);
	const mapHeight = $derived(height || 720);
	const narrow = $derived(mapWidth <= 520);

	/** Set by "Try another location", so the search form comes back without
	 *  throwing away the answer until a new one arrives. */
	let editing = $state(false);
	let submitting = $state(false);
	let canGeolocate = $state(false);
	let geoError = $state<string | null>(null);
	let geoLat = $state('');
	let geoLng = $state('');
	let geoForm = $state<HTMLFormElement>();
	/** Bumped when the theme changes, so the canvases repaint in the new colours. */
	let themeVersion = $state(0);

	const result = $derived(nearby && !editing ? nearby : null);
	const level = $derived(result ? CANVASSER_LEVELS[result.canvassers]! : null);

	// --- Map framing -------------------------------------------------------

	/** Centre of the US, for a deployment with no turf mapped yet. */
	const FALLBACK_CENTRE: LatLng = { lat: 39.8, lng: -98.6 };
	const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

	const focus = $derived(result?.centre ?? turfCentre ?? FALLBACK_CENTRE);

	// With a result, zoom so the 2-mile ring fills most of the short side; the
	// card sits inside it on a desktop. Before one, show the campaign's region.
	const zoom = $derived.by(() => {
		if (!result) return turfCentre ? 9 : 4;
		const ringRadiusPx = Math.min(mapWidth, mapHeight) * (narrow ? 0.46 : 0.42);
		const wantMetresPerPx = (NEARBY_RADIUS_MILES * METRES_PER_MILE) / ringRadiusPx;
		const z = Math.log2(
			(EARTH_CIRCUMFERENCE_M * Math.cos((focus.lat * Math.PI) / 180)) / (256 * wantMetresPerPx),
		);
		return Math.min(MAX_ZOOM - 1, Math.max(MIN_ZOOM, z));
	});

	// On a phone the card sits at the bottom, so the visitor's point is raised
	// to the top third where it can be seen.
	const view = $derived.by(() => {
		const size = { zoom, width: mapWidth, height: mapHeight };
		const anchorY = narrow && result ? mapHeight * 0.3 : mapHeight / 2;
		const provisional = createMapView({ centre: focus, ...size });
		const centre = provisional.unproject({ x: mapWidth / 2, y: mapHeight - anchorY });
		return createMapView({ centre, ...size });
	});

	const pxPerMile = $derived(METRES_PER_MILE / metresPerPixel(focus.lat, zoom));
	const focusPx = $derived(view.project(focus));
	const screenCells = $derived<ScreenCell[]>(
		(result?.cells ?? []).map((c) => ({ ...view.project(c), w: c.w })),
	);
	const field = $derived<Field>({
		cx: focusPx.x,
		cy: focusPx.y,
		pxPerMile,
		width: mapWidth,
		height: mapHeight,
		cells: screenCells,
		cellPx: CELL_MILES * pxPerMile,
	});

	// --- Canvases ----------------------------------------------------------

	function token(el: Element, name: string): string {
		return getComputedStyle(el).getPropertyValue(name).trim();
	}

	function prepare(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.round(mapWidth * dpr);
		canvas.height = Math.round(mapHeight * dpr);
		const ctx = canvas.getContext('2d');
		ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx?.clearRect(0, 0, mapWidth, mapHeight);
		return ctx;
	}

	function densityLayer(canvas: HTMLCanvasElement) {
		void themeVersion;
		const ctx = prepare(canvas);
		if (!ctx) return;
		drawDensity(ctx, screenCells, field.cellPx, token(canvas, '--color-blue'));
	}

	// Kept outside reactive state: the animation mutates these sixty times a
	// second and nothing in the template reads them.
	let walkers: Walker[] = [];
	let walkerFieldKey = '';

	function walkerLayer(canvas: HTMLCanvasElement) {
		void themeVersion;
		const ctx = prepare(canvas);
		if (!ctx) return;
		const current = field;
		const colors = { fill: token(canvas, '--color-coral'), edge: token(canvas, '--color-surface') };
		const count = level ? dotsForLevel(result!.canvassers) : 0;

		// A new place or a resize moves every pixel; start the dots over rather
		// than leave them stranded off the new frame.
		const key = `${current.cx}|${current.cy}|${current.pxPerMile}`;
		if (key !== walkerFieldKey) {
			walkers = [];
			walkerFieldKey = key;
		}
		syncWalkers(walkers, count, current, performance.now());
		if (walkers.length === 0) return;

		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (still) {
			drawWalkers(ctx, walkers, colors, Infinity);
			return;
		}

		let frame = 0;
		let last = performance.now();
		const loop = (now: number) => {
			const dt = Math.min(0.1, (now - last) / 1000);
			last = now;
			stepWalkers(walkers, current, dt);
			ctx.clearRect(0, 0, mapWidth, mapHeight);
			drawWalkers(ctx, walkers, colors, now);
			frame = requestAnimationFrame(loop);
		};
		frame = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(frame);
	}

	function watchTheme() {
		const bump = () => themeVersion++;
		const observer = new MutationObserver(bump);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme'],
		});
		const dark = window.matchMedia('(prefers-color-scheme: dark)');
		dark.addEventListener('change', bump);
		canGeolocate = 'geolocation' in navigator;
		return () => {
			observer.disconnect();
			dark.removeEventListener('change', bump);
		};
	}

	// --- Lookup ------------------------------------------------------------

	const submitLookup: SubmitFunction = () => {
		submitting = true;
		geoError = null;
		return async ({ update }) => {
			// The answer is in `form`; there is nothing on the page to reload.
			await update({ invalidateAll: false, reset: false });
			submitting = false;
			editing = false;
		};
	};

	function useLocation() {
		geoError = null;
		submitting = true;
		navigator.geolocation.getCurrentPosition(
			async (pos) => {
				// Rounded here as well as on the server: a neighbourhood is all
				// the lookup needs, so the exact spot never leaves the device.
				geoLat = pos.coords.latitude.toFixed(3);
				geoLng = pos.coords.longitude.toFixed(3);
				await tick();
				geoForm?.requestSubmit();
			},
			() => {
				submitting = false;
				geoError = "We couldn't get your location. Enter an address or ZIP code instead.";
			},
			{ timeout: 10_000, maximumAge: 300_000 },
		);
	}
</script>

<section class="teaser" bind:clientWidth={width} bind:clientHeight={height} {@attach watchTheme}>
	<div class="stage" aria-hidden="true">
		<div class="tiles">
			{#each view.tiles as tile (tile.key)}
				<img
					src={tileUrl(tile, tiles.urlTemplate)}
					alt=""
					draggable="false"
					style:left="{tile.left}px"
					style:top="{tile.top}px"
					style:width="{tile.size}px"
					style:height="{tile.size}px"
				/>
			{/each}
		</div>
		<canvas class="density" {@attach densityLayer}></canvas>
		<canvas class="walkers" {@attach walkerLayer}></canvas>
		{#if result}
			<svg class="ring" viewBox="0 0 {mapWidth} {mapHeight}">
				<circle cx={focusPx.x} cy={focusPx.y} r={NEARBY_RADIUS_MILES * pxPerMile} />
				<g transform="translate({focusPx.x} {focusPx.y - NEARBY_RADIUS_MILES * pxPerMile})">
					<rect x="-22" y="-12" width="44" height="24" rx="12" />
					<text y="1">2 MI</text>
				</g>
			</svg>
		{/if}
	</div>

	<div class="shell">
		<div class="card" aria-live="polite">
			{#if result && level}
				<div class="doors">
					<div class={['lockup', result.doors.kind !== 'over' && 'words']}>
						{#if result.doors.kind === 'over'}
							<span class="over">Over</span>
							<span class="num">{result.doors.atLeast}</span>
							<span class="unit"><strong>doors</strong> to be knocked</span>
						{:else if result.doors.kind === 'handful'}
							<span class="num words">A handful</span>
							<span class="unit"><strong>of doors</strong> to be knocked</span>
						{:else if result.doors.kind === 'all-taken'}
							<span class="num words">All taken</span>
							<span class="unit"
								>Every turf near you has someone on it right now. More opens up as it's walked.</span
							>
						{:else}
							<span class="num words">No turf yet</span>
							<span class="unit"
								>Nobody has cut turf near you yet, but there's other work to do.</span
							>
						{/if}
					</div>
					{#if result.doors.kind !== 'none'}
						<span class="unit">within 2 miles of {placeLabel(result.place)}</span>
					{/if}
				</div>

				<div class="people">
					<div class="pips" aria-hidden="true">
						{#each CANVASSER_LEVELS as step, i (step.label)}
							<span class={['pip', result.canvassers > 0 && i <= result.canvassers && 'on']}></span>
						{/each}
					</div>
					<div class="pip-scale" aria-hidden="true"><span>No one</span><span>Tons</span></div>
					<p>{level.sentence}</p>
				</div>

				{@render actions()}

				<div class="foot">
					<button class="linklike" type="button" onclick={() => (editing = true)}>
						Try another location
					</button>
				</div>
			{:else}
				<p class="eyebrow"><span class="dot"></span>Canvass near you</p>
				<h2>How much turf is on your block?</h2>
				<p class="lede">
					See how many doors are waiting within two miles of you, and how many neighbors are already
					out knocking.
				</p>
				<form method="POST" action="?/nearby" use:enhance={submitLookup}>
					<label class="field-label" for="teaser-q">Your address or ZIP code</label>
					<div class="input-row">
						<input
							id="teaser-q"
							name="q"
							type="text"
							autocomplete="street-address"
							placeholder="e.g. 48104 or 123 Main St"
							maxlength="200"
							required
						/>
						<button class="go" type="submit" disabled={submitting}>
							{submitting ? 'Looking…' : 'Look'}
						</button>
					</div>
				</form>
				{#if canGeolocate}
					<div class="or">or</div>
					<button class="locate" type="button" onclick={useLocation} disabled={submitting}>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							aria-hidden="true"
							><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg
						>
						Use my location
					</button>
					<form
						bind:this={geoForm}
						method="POST"
						action="?/nearby"
						use:enhance={submitLookup}
						hidden
					>
						<input name="lat" type="hidden" value={geoLat} />
						<input name="lng" type="hidden" value={geoLng} />
					</form>
				{/if}
				{#if error || geoError}
					<p class="error" role="alert">{geoError ?? error}</p>
				{/if}
				<p class="fine">We don't save your address. It's only used to find turf near you.</p>
				<div class="ready">
					{@render actions()}
				</div>
			{/if}
		</div>
	</div>

	<p class="attribution">{tiles.attribution}</p>
</section>

{#snippet actions()}
	<div class="actions">
		{#if joinUrl}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an external sign-up page from settings -->
			<a class="cta" href={joinUrl} rel="noopener">
				<span><span class="q">Want to get involved?</span><span class="a">Join our chat</span></span
				>
				{@render arrow()}
			</a>
		{/if}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the sign-in page with its return path -->
		<a class="cta soft" href={signInHref}>
			<span><span class="q">Already volunteering?</span><span class="a">Sign in</span></span>
			{@render arrow()}
		</a>
	</div>
{/snippet}

{#snippet arrow()}
	<svg
		class="arrow"
		viewBox="0 0 48 48"
		fill="none"
		stroke="currentColor"
		stroke-width="4"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"><path d="M6 24h34M27 11l13 13-13 13" /></svg
	>
{/snippet}

<style>
	.teaser {
		position: relative;
		isolation: isolate;
		overflow: hidden;
		min-height: max(560px, calc(100dvh - 64px));
		display: grid;
		background: var(--color-bg);
		font-family: var(--font-body);
		color: var(--color-text);
	}

	/* ---- Map ---------------------------------------------------------- */
	.stage {
		position: absolute;
		inset: 0;
		z-index: 0;
		pointer-events: none;
	}
	/* Scaled up a touch so each blur's soft edge falls outside the frame
	   instead of fading to a pale border. */
	.tiles,
	.density,
	.walkers {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		transform: scale(1.06);
	}
	.tiles {
		filter: blur(2.5px);
	}
	.tiles img {
		position: absolute;
		max-width: none;
		user-select: none;
	}
	.density {
		filter: blur(22px);
	}
	.ring {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.ring circle {
		fill: none;
		stroke: var(--color-text);
		stroke-opacity: 0.55;
		stroke-width: 2;
		stroke-dasharray: 10 8;
	}
	.ring rect {
		fill: var(--color-text);
	}
	.ring text {
		fill: var(--color-surface);
		font-family: var(--font-display);
		font-weight: 500;
		font-size: 13px;
		text-anchor: middle;
		dominant-baseline: middle;
		letter-spacing: 0.06em;
	}
	/* Washes the edges toward the page colour so the card is the focus. */
	.stage::after {
		content: '';
		position: absolute;
		inset: 0;
		background: radial-gradient(
			ellipse at 50% 45%,
			transparent 45%,
			color-mix(in srgb, var(--color-bg) 70%, transparent) 100%
		);
	}
	.attribution {
		position: absolute;
		right: 8px;
		bottom: 6px;
		z-index: 1;
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}

	/* ---- Card --------------------------------------------------------- */
	.shell {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		padding: 24px 16px;
	}
	.card {
		width: 100%;
		max-width: 440px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 16px;
		box-shadow: var(--shadow-modal);
		padding: 28px 28px 24px;
		display: grid;
		gap: 20px;
		font-size: 17px;
		line-height: 1.45;
	}
	.eyebrow {
		margin: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-display);
		font-weight: 500;
		font-size: 13px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}
	.eyebrow .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-coral);
	}
	h2 {
		margin: 0;
		font-family: var(--font-display);
		font-weight: 700;
		font-size: clamp(30px, 7vw, 38px);
		line-height: 1.02;
		text-transform: uppercase;
		text-wrap: balance;
		color: var(--color-text);
	}
	.lede {
		margin: 0;
		color: var(--color-text-muted);
	}

	form {
		display: grid;
		gap: 10px;
	}
	.field-label {
		font-weight: 600;
		font-size: 15px;
	}
	.input-row {
		display: flex;
		gap: 8px;
	}
	input[type='text'] {
		flex: 1;
		min-width: 0;
		font: inherit;
		color: var(--color-text);
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 11px 14px;
	}
	input[type='text']::placeholder {
		color: var(--color-text-faint);
	}
	button {
		font: inherit;
		cursor: pointer;
	}
	button:disabled {
		cursor: default;
		opacity: 0.7;
	}
	.go {
		border: 0;
		border-radius: 10px;
		padding: 11px 18px;
		background: var(--color-action);
		color: var(--color-action-text);
		font-family: var(--font-display);
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.or {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 14px;
		color: var(--color-text-faint);
	}
	.or::before,
	.or::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--color-border);
	}
	.locate {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 11px 16px;
		background: transparent;
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		font-weight: 600;
	}
	.locate svg {
		width: 18px;
		height: 18px;
	}
	.error {
		margin: 0;
		color: var(--color-error);
		font-weight: 600;
	}
	.fine {
		margin: 0;
		font-size: 13px;
		color: var(--color-text-faint);
	}
	.linklike {
		color: var(--color-action);
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 3px;
		text-decoration-thickness: 1px;
	}
	.linklike {
		background: none;
		border: 0;
		padding: 0;
	}

	/* ---- Result ------------------------------------------------------- */
	.doors {
		display: grid;
		gap: 2px;
		justify-items: center;
		text-align: center;
	}
	/* The number sets the width: "Over" hangs off its left edge and the unit
	   off its right. The distance line sits centred underneath. */
	.lockup {
		display: inline-grid;
	}
	.over {
		justify-self: start;
		font-family: var(--font-display);
		font-weight: 500;
		font-size: 15px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}
	.num {
		justify-self: center;
		font-family: var(--font-display);
		font-weight: 700;
		font-size: clamp(84px, 26vw, 120px);
		line-height: 0.9;
		letter-spacing: -0.01em;
		font-variant-numeric: tabular-nums;
		color: var(--color-text);
	}
	.num.words {
		font-size: clamp(40px, 11vw, 52px);
		line-height: 1;
		text-transform: uppercase;
		text-wrap: balance;
	}
	.unit {
		font-size: 18px;
		color: var(--color-text-muted);
	}
	.unit strong {
		color: var(--color-text);
	}
	.lockup .unit {
		justify-self: end;
		text-align: right;
		margin-top: 4px;
	}
	.lockup.words .unit {
		justify-self: center;
		text-align: center;
	}

	.people {
		display: grid;
		gap: 8px;
		padding: 14px 16px;
		border-radius: 12px;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
	}
	.people p {
		margin: 0;
		font-weight: 600;
	}
	.pips {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 4px;
	}
	.pip {
		height: 6px;
		border-radius: 3px;
		background: var(--color-border);
	}
	.pip.on {
		background: var(--color-action);
	}
	.pip-scale {
		display: flex;
		justify-content: space-between;
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-text-faint);
	}

	.actions {
		display: grid;
		gap: 10px;
	}
	/* The search card's closing section: the same two buttons as the result,
	   for someone who is sold before they have looked anything up. */
	.ready {
		display: grid;
		gap: 12px;
		padding-top: 20px;
		border-top: 1px solid var(--color-border);
	}
	.cta {
		--cta-bg: var(--color-coral);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 18px;
		border-radius: 12px;
		background: var(--cta-bg);
		color: var(--color-on-accent);
		text-decoration: none;
		transition:
			transform 0.15s ease,
			box-shadow 0.15s ease;
	}
	.cta.soft {
		--cta-bg: var(--color-gold-light);
	}
	.cta:hover {
		transform: translateY(-1px);
		box-shadow: 0 8px 20px -8px color-mix(in srgb, var(--cta-bg) 70%, transparent);
	}
	.cta .q {
		display: block;
		font-size: 14px;
		font-weight: 600;
		opacity: 0.85;
	}
	.cta .a {
		display: block;
		font-family: var(--font-display);
		font-weight: 700;
		font-size: 22px;
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}
	.cta .arrow {
		flex: none;
		width: 48px;
		height: 48px;
		transition: transform 0.15s ease;
	}
	.cta:hover .arrow {
		transform: translateX(3px);
	}
	.foot {
		display: flex;
		font-size: 15px;
	}

	:focus-visible {
		outline: 3px solid var(--color-border-focus);
		outline-offset: 2px;
	}

	@media (max-width: 520px) {
		.shell {
			place-items: end center;
			padding: 72px 16px 16px;
		}
		.card {
			padding: 22px 20px 20px;
			gap: 16px;
			font-size: 16px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cta,
		.cta:hover,
		.cta .arrow,
		.cta:hover .arrow {
			transition: none;
			transform: none;
		}
	}
</style>

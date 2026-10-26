<script lang="ts">
	// Where a walk's meeting place landed on the map (specs/015-mentor-walks,
	// FR-007), for the mentor to check before posting. The geocoder sometimes
	// takes a half-understood address to the wrong town, and a pin on a street
	// map is how that gets noticed.
	//
	// A still picture: the same tiles as the turf map, centred on the pin, with
	// nothing to drag. Moving the pin is done by changing the address.

	import { createMapView, TILE_ATTRIBUTION, TILE_URL_TEMPLATE, tileUrl } from '$lib/van/tiles.js';
	import { STREET_ZOOM } from '$lib/van/map-focus.js';

	interface Props {
		point: { lat: number; lng: number };
		/** Basemap source, as /turfs is given it. */
		tiles?: { urlTemplate: string; attribution: string };
		/** Spoken in place of the picture. */
		label: string;
	}

	let {
		point,
		tiles = { urlTemplate: TILE_URL_TEMPLATE, attribution: TILE_ATTRIBUTION },
		label,
	}: Props = $props();

	const HEIGHT = 200;

	let width = $state(0);
	const view = $derived(
		createMapView({ centre: point, zoom: STREET_ZOOM, width: width || 480, height: HEIGHT }),
	);
	const pin = $derived(view.project(point));

	/** For the label-darkening filter; one per preview on the page. */
	const uid = $props.id();
	const filterId = `mw-place-ink-${uid}`;
</script>

<figure class="mw-place-preview" bind:clientWidth={width} style:height="{HEIGHT}px">
	<!-- The light basemap's street names are pale grey, hard to read at a
	     glance. A gamma curve darkens greys a lot and near-whites a little,
	     so the names stand out and white roads stay white. -->
	<svg class="filter-defs" aria-hidden="true">
		<filter id={filterId} color-interpolation-filters="sRGB">
			<feComponentTransfer>
				<feFuncR type="gamma" exponent="2.4" />
				<feFuncG type="gamma" exponent="2.4" />
				<feFuncB type="gamma" exponent="2.4" />
			</feComponentTransfer>
		</filter>
	</svg>
	<div class="tiles" role="img" aria-label={label} style:filter="url(#{filterId})">
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
	<span class="pin" style:left="{pin.x}px" style:top="{pin.y}px" aria-hidden="true"></span>
	<figcaption class="attribution">{tiles.attribution}</figcaption>
</figure>

<style>
	.mw-place-preview {
		position: relative;
		margin: 0;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-alt);
	}

	.tiles {
		position: absolute;
		inset: 0;
	}

	.filter-defs {
		position: absolute;
		width: 0;
		height: 0;
	}

	.tiles img {
		position: absolute;
		max-width: none;
		user-select: none;
	}

	/* A drop pin whose point sits on the spot. */
	.pin {
		position: absolute;
		width: 22px;
		height: 22px;
		margin: -27px 0 0 -11px;
		border: 3px solid var(--color-bg);
		border-radius: 50% 50% 50% 0;
		background: var(--color-action);
		box-shadow: 0 1px 4px color-mix(in srgb, var(--color-near-black) 35%, transparent);
		transform: rotate(-45deg);
		transform-origin: 50% 50%;
	}

	.attribution {
		position: absolute;
		right: 6px;
		bottom: 4px;
		padding: 0 4px;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--color-bg) 80%, transparent);
		font-size: var(--font-size-xs);
		color: var(--color-text-faint);
	}
</style>

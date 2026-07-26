<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<!-- The dashboard's LED sign: dark panel, bezel, and a single diode grid laid
     over everything inside it. Whatever it wraps (countdown, ticker) reads as
     one physical board rather than as separate widgets that happen to share a
     colour scheme. -->
<div class="board">
	<div class="board__grid" aria-hidden="true"></div>
	{@render children()}
</div>

<style>
	.board {
		/* Spacing of the diode grid. Small enough to read as dots rather than
		   as a screen door over the text. */
		--led-pitch: 3px;

		/* Silkscreen is drawn on a 10-unit grid per em (caps are 7 of those
		   units, verified from the font's head/OS2 tables), so one glyph pixel
		   is exactly font-size / 10 — which makes glyph pixels, not font-size,
		   the honest unit to size this board in. Whole-pixel values keep every
		   glyph edge on a device pixel; the bitmap letterforms go soft at
		   arbitrary sizes, and softness is the one thing that breaks the LED
		   illusion.
		   --glyph-px is the body size the ticker inherits. It stays at 2.5px
		   (a deliberate half pixel: crisp at 2x, marginally soft at 1x). */
		--glyph-px: 2.5px;
		--glyph-px-label: 3px;
		--glyph-px-note: 2px;
		/* The clock steps through whole pixels rather than using a fluid
		   clamp(): clamp() would land on a fractional glyph pixel at almost
		   every viewport width and blur the digits. Discrete steps stay sharp
		   at every size. */
		--glyph-px-clock: 3px;

		position: relative;
		/* Contains the children's stacking contexts so the grid overlay below
		   stays on top of all of them. */
		isolation: isolate;
		overflow: hidden;
		border-radius: var(--radius-lg);
		background: #07070a;
		border: 1px solid #26262e;
		box-shadow:
			inset 0 2px 14px rgba(0, 0, 0, 0.9),
			0 2px 6px rgba(0, 0, 0, 0.3);
		padding: 18px 0 14px;
	}

	@media (min-width: 480px) {
		.board {
			--glyph-px-clock: 4px;
		}
	}
	@media (min-width: 900px) {
		.board {
			--glyph-px-clock: 5px;
		}
	}

	/* The diodes: opaque panel colour everywhere EXCEPT a lattice of small
	   holes, sitting above the content. Lit glyphs and dark background get
	   chopped into the same uniform pitch — which is how a physical board
	   works, the LEDs are fixed and the message passes through them. Doing it
	   as one overlay rather than masking each glyph means nothing has to align
	   with the font's pixel grid, and the dots can't shimmer against moving
	   letters.
	   Hole radius ~1px on a 3px pitch leaves roughly a third of the panel
	   open — close to the fill factor of a real board. */
	.board__grid {
		position: absolute;
		inset: 0;
		background-image: radial-gradient(circle at center, transparent 0 1px, #07070a 1.3px 100%);
		background-size: var(--led-pitch) var(--led-pitch);
		pointer-events: none;
		z-index: 5;
	}
</style>

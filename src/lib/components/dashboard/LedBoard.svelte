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
		/* Silkscreen is drawn on a 10-unit grid per em (caps are 7 of those
		   units, verified from the font's head/OS2 tables), so one glyph pixel
		   is exactly font-size / 10 — which makes glyph pixels, not font-size,
		   the honest unit to size this board in. Whole-pixel values keep every
		   glyph edge on a device pixel; the bitmap letterforms go soft at
		   arbitrary sizes, and softness is the one thing that breaks the LED
		   illusion.
		   The diode pitch and the ticker's glyph pixel are ONE value, and must
		   stay that way. The scrolling message advances exactly one pitch per
		   step, so when a glyph pixel is the same size as a diode, every lit
		   pixel lands on the next diode and the board reads as LEDs switching
		   on and off. At any other ratio each hole samples a different part of
		   a glyph pixel on every step, the on/off pattern beats against itself,
		   and the eye reads that moiré as the message sliding under a screen
		   door — that is what a 3px pitch against 2.5px glyph pixels looked
		   like, a five-step beat. Anything in the ticker that scrolls must
		   therefore be sized at exactly --glyph-px, never a fraction of it.
		   A whole number of CSS pixels matters here beyond ordinary crispness:
		   the message advances one pitch per step, so a fractional pitch puts
		   alternating steps on half device pixels and the board breathes
		   between sharp and soft. (Only exact at 100% and 200% display
		   scaling — at 125% nothing lands whole and there is no fixing it
		   from here.) Changing this resizes the ticker's type with it. */
		--led-pitch: 3px;
		--glyph-px: var(--led-pitch);
		/* The countdown is static, so it is free of the alignment rule above —
		   nothing beats when nothing moves. */
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
		background: var(--led-panel);
		border: 1px solid var(--led-bezel);
		box-shadow:
			inset 0 2px 14px color-mix(in srgb, var(--led-panel) 90%, transparent),
			0 2px 6px color-mix(in srgb, var(--led-panel) 30%, transparent);
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
	   The hole radius is a fraction of the pitch rather than a fixed length, so
	   retuning --glyph-px keeps the same ~1/3 open area — close to the fill
	   factor of a real board. Smaller reads as a screen door over the text;
	   larger loses the dot structure. */
	.board__grid {
		position: absolute;
		inset: 0;
		background-image: radial-gradient(
			circle at center,
			transparent 0 calc(var(--led-pitch) * 0.34),
			var(--led-panel) calc(var(--led-pitch) * 0.44) 100%
		);
		background-size: var(--led-pitch) var(--led-pitch);
		pointer-events: none;
		z-index: 5;
	}
</style>

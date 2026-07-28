<script lang="ts">
	import type { TickerEntry } from '$lib/server/door-knock-ticker.js';
	import { DEFAULT_TICKER_COLUMNS_PER_SECOND } from '$lib/ticker-speed.js';

	interface Props {
		entries: TickerEntry[];
		/** LED columns advanced per second — the board's actual speed.
		 *
		 *  Timing is driven from this rather than from a total duration
		 *  because the motion is stepped: what the eye judges is the cadence
		 *  of the steps, not how long a lap takes. Deriving it the other way
		 *  round (a duration from the entry count, with the step count coming
		 *  from a measurement) left the real rate to fall out of whatever the
		 *  rendered names happened to be wide — unstable, and fast enough that
		 *  each step lasted barely more than a frame. Steps that short land on
		 *  ragged frame boundaries, and that is what read as stutter.
		 *
		 *  30 divides both common refresh rates exactly — a step every 2 frames
		 *  at 60 Hz, every 4 at 120 Hz — so every step is held the same length.
		 *  The other even cadences are 60/k for whole k: 60, 20, 15, 12, 10.
		 *  Nothing between 30 and 60 divides evenly, so rates in that gap
		 *  alternate one- and two-frame steps; that still reads acceptably.
		 *  60 is the hard ceiling — one column per frame at 60 Hz. Beyond it
		 *  the browser cannot draw every step and starts skipping columns,
		 *  which is the jumping this animation exists to avoid. */
		columnsPerSecond?: number;
	}

	let { entries, columnsPerSecond = DEFAULT_TICKER_COLUMNS_PER_SECOND }: Props = $props();

	// A real matrix sign doesn't glide — it shifts the message one LED column
	// at a time. steps() gives exactly that, but only if the step count equals
	// how many LED columns the strip spans, which depends on rendered text
	// width and so can't be known in CSS. Measure it.
	//
	// Stepping the travel (-50%, i.e. exactly one strip) into N parts rather
	// than translating by a computed N x pitch keeps the loop seam exact; the
	// cost is that each step is stripWidth/N instead of precisely one pitch,
	// which for a strip of any real length is off by thousandths of a pixel.
	let steps = $state(0);

	/** Attachment on the measured strip: counts how many LED columns it spans
	 *  and keeps that current. The ResizeObserver also catches the reflow when
	 *  Silkscreen finishes loading — font-display: swap renders the fallback
	 *  first, at a different width. */
	function countColumns(node: HTMLElement) {
		const measure = () => {
			const pitch = parseFloat(getComputedStyle(node).getPropertyValue('--led-pitch')) || 3;
			steps = Math.max(1, Math.round(node.getBoundingClientRect().width / pitch));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}

	// Before the strip is measured — during SSR and the first frames — stand in
	// a nominal column count so the animation is well-formed rather than
	// steps(0), which is invalid and would kill it outright. The observer
	// replaces it as soon as layout settles.
	const FALLBACK_COLUMNS = 400;
	const columns = $derived(steps > 0 ? steps : FALLBACK_COLUMNS);

	// The strip is rendered twice back to back and translated by exactly -50%,
	// so the second copy is under the cursor the instant the first scrolls out
	// and the loop has no visible seam. One lap covers one copy — which at a
	// fixed column rate takes as long as that copy is wide.
	const duration = $derived(columns / columnsPerSecond);

	const trackStyle = $derived(`--ticker-duration:${duration}s;--ticker-steps:${columns}`);
</script>

{#if entries.length > 0}
	<!-- The whole board is aria-hidden: it's a moving target, it renders the
	     list twice for the seamless loop, and the sr-only list below carries
	     the same information in a readable form. -->
	{#snippet cells()}
		{#each entries as entry (entry.canvasser)}
			<div class="cell" class:cell--lead={entry.rank === 1}>
				<span class="cell__name">{entry.canvasser}</span>
				<!-- No separators between count, unit and region: colour does that
				     job, and a punctuation glyph would just eat LED columns. -->
				<span class="cell__doors"
					><span class="cell__count">{entry.doors.toLocaleString('en-US')}</span><span
						class="cell__unit">doors</span
					>{#if entry.chapter}<span class="cell__region">{entry.chapter}</span>{/if}</span
				>
			</div>
		{/each}
	{/snippet}

	<div class="ticker" style={trackStyle} aria-hidden="true">
		<p class="ticker__header">Most doors knocked today:</p>
		<div class="ticker__track">
			<!-- Only the first copy is measured; the second exists to cover the
			     seam and is identical by construction. -->
			<div class="ticker__strip" {@attach countColumns}>{@render cells()}</div>
			<div class="ticker__strip">{@render cells()}</div>
		</div>
	</div>

	<ol class="ticker__sr" aria-label="Most doors knocked today">
		{#each entries as entry (entry.canvasser)}
			<li>
				{entry.canvasser}: {entry.doors} doors knocked{entry.chapter ? ` in ${entry.chapter}` : ''}
			</li>
		{/each}
	</ol>
{/if}

<style>
	/* Renders inside <LedBoard>, which supplies the panel, the diode grid and
	   the --glyph-px / --led-pitch sizes; the fallbacks below only matter if
	   this is ever used on its own. Only the marquee's clipping and edge
	   fades are the ticker's own business. */
	.ticker {
		position: relative;
		overflow: hidden;
		width: 100%;
		margin-top: 14px;
	}

	/* Both ends fade into the panel so cells enter and leave instead of
	   popping at a hard edge. */
	.ticker::after {
		content: '';
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 2;
		background: linear-gradient(90deg, #07070a 0%, transparent 6%, transparent 94%, #07070a 100%);
	}

	/* Static caption line, the way a real board holds a fixed label above the
	   scrolling message. It sits under the board's diode grid like everything
	   else, so it reads as part of the sign rather than as a caption on top
	   of one. Exempt from the one-glyph-pixel-per-LED rule the cells follow:
	   it never moves, so it has nothing to beat against. */
	.ticker__header {
		margin: 0 0 8px;
		text-align: center;
		font-family: 'Silkscreen', 'Courier New', monospace;
		font-size: calc(var(--glyph-px, 3px) * 10 * 0.75);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		/* Amber, the classic caption colour on these boards. It's the same
		   amber the day's leader burns below — shared on purpose, so the eye
		   reads caption and leader as the board's own voice while the ordinary
		   entries stay white-on-green. */
		color: #ffb02e;
		text-shadow:
			0 0 6px rgba(255, 176, 46, 0.6),
			0 0 16px rgba(255, 140, 20, 0.35);
	}

	/* steps() rather than linear: the message jumps one LED column per step
	   instead of gliding between them, which is what a physical matrix sign
	   does and what keeps the glyphs registered with the diode grid.
	   --ticker-steps is measured in script; the fallback only covers the first
	   frames before that lands, and is deliberately coarse rather than smooth
	   so the motion never starts out gliding and then snap-changes. */
	.ticker__track {
		display: flex;
		width: max-content;
		animation: ticker-scroll var(--ticker-duration) steps(var(--ticker-steps, 400)) infinite;
	}
	.ticker:hover .ticker__track {
		animation-play-state: paused;
	}

	@keyframes ticker-scroll {
		from {
			transform: translate3d(0, 0, 0);
		}
		to {
			transform: translate3d(-50%, 0, 0);
		}
	}

	.ticker__strip {
		display: flex;
		flex: 0 0 auto;
	}

	.cell {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		/* Whole LED columns/rows, so the two lines and each cell keep a
		   consistent phase against the diode grid. */
		gap: calc(var(--led-pitch, 3px) * 2);
		padding: 0 calc(var(--led-pitch, 3px) * 16);
		white-space: nowrap;
		/* Blocky bitmap glyphs survive being chopped into dots; a smooth
		   typeface would come out as mush at this pitch. */
		font-family: 'Silkscreen', 'Courier New', monospace;
	}

	.cell__name {
		font-size: calc(var(--glyph-px, 3px) * 10);
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #eaf2ff;
		text-shadow:
			0 0 4px rgba(190, 220, 255, 0.85),
			0 0 12px rgba(120, 170, 255, 0.5);
	}

	/* Count, unit and region all sit at ONE glyph pixel per LED. They used to
	   be 0.75x, which put them on a grid the diodes don't share and left them
	   moiréing while the rest of the cell stepped cleanly. Hierarchy on this
	   line is carried entirely by colour, which costs no alignment. Gaps are
	   whole LED columns for the same reason. */
	.cell__doors {
		font-size: calc(var(--glyph-px, 3px) * 10);
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	/* Green for the counts, matching the up-ticks on a stock board. */
	.cell__count {
		color: #3dff85;
		text-shadow:
			0 0 5px rgba(61, 255, 133, 0.9),
			0 0 16px rgba(61, 255, 133, 0.45);
	}
	/* Same green, burning lower — reads as the number's unit, not as a value. */
	.cell__unit {
		margin-left: calc(var(--led-pitch, 3px) * 2);
		color: #1f8a4a;
		text-shadow: 0 0 4px rgba(45, 190, 100, 0.4);
	}
	/* The region in the names' cool white, so the eye separates "how many"
	   from "where" without a separator or a third row. */
	.cell__region {
		margin-left: calc(var(--led-pitch, 3px) * 3);
		color: #b9cfe8;
		text-shadow: 0 0 5px rgba(150, 190, 240, 0.5);
	}

	.cell--lead .cell__count {
		color: #ffb02e;
		text-shadow:
			0 0 6px rgba(255, 176, 46, 0.95),
			0 0 18px rgba(255, 140, 20, 0.5);
	}
	.cell--lead .cell__unit {
		color: #9c6a15;
		text-shadow: 0 0 4px rgba(200, 140, 40, 0.4);
	}
	.cell--lead .cell__region {
		color: #ffd98a;
		text-shadow: 0 0 5px rgba(255, 200, 110, 0.6);
	}

	/* Day's leader burns amber, the way a board highlights the mover. */
	.cell--lead .cell__name {
		color: #ffd98a;
		text-shadow:
			0 0 4px rgba(255, 200, 110, 0.9),
			0 0 14px rgba(255, 170, 60, 0.55);
	}

	/* A scrolling marquee is exactly what this setting is for — hold the board
	   still and let people read the top of the list. */
	@media (prefers-reduced-motion: reduce) {
		.ticker__track {
			animation: none;
		}
	}

	.ticker__sr {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>

<script lang="ts">
	import type { TickerEntry } from '$lib/server/door-knock-ticker.js';

	interface Props {
		entries: TickerEntry[];
		/** Seconds for one full pass of the list. Scaled by entry count below so
		 *  a long list doesn't crawl and a short one doesn't race. */
		secondsPerEntry?: number;
	}

	let { entries, secondsPerEntry = 3.2 }: Props = $props();

	// The strip is rendered twice back to back and translated by exactly -50%,
	// so the second copy is under the cursor the instant the first scrolls out
	// and the loop has no visible seam. Duration covers one copy.
	const duration = $derived(Math.max(entries.length * secondsPerEntry, 8));
	const durationStyle = $derived(`--ticker-duration:${duration}s`);
</script>

{#if entries.length > 0}
	<div class="ticker" style={durationStyle}>
		<div class="ticker__glass" aria-hidden="true"></div>
		<div class="ticker__track">
			{#each [0, 1] as copy (copy)}
				<div class="ticker__strip" aria-hidden={copy === 1 ? 'true' : undefined}>
					{#each entries as entry (entry.canvasser)}
						<div class="cell" class:cell--lead={entry.rank === 1}>
							<span class="cell__name">{entry.canvasser}</span>
							<span class="cell__doors">
								{entry.doors.toLocaleString('en-US')}
								<span class="cell__unit">doors</span>
							</span>
						</div>
					{/each}
				</div>
			{/each}
		</div>
	</div>

	<!-- The scrolling board is decorative motion; screen readers get the
	     standings as a plain ordered list instead of a moving target. -->
	<ol class="ticker__sr">
		{#each entries as entry (entry.canvasser)}
			<li>{entry.canvasser}: {entry.doors} doors knocked</li>
		{/each}
	</ol>
{/if}

<style>
	.ticker {
		/* LED pitch — the spacing of the diode grid. Small enough to read as
		   dots rather than as a screen door. */
		--led-pitch: 3px;
		/* Silkscreen is drawn on a 10-unit grid per em (caps are 7 of those
		   units, verified from the font's head/OS2 tables), so one glyph pixel
		   is exactly font-size / 10 — which makes glyph pixels, not font-size,
		   the honest unit to size this board in. Name and count share one
		   value so the two lines read as a single uniform panel; the count is
		   set apart by colour, not by size.
		   At 2.5px the caps are 17.5px tall. Note that's a half glyph pixel:
		   crisp on a 2x display, marginally soft on a 1x one. Whole-pixel
		   values (2px, 3px) are the hard-edged alternatives if that ever
		   matters more than the exact size. */
		--glyph-px: 2.5px;
		position: relative;
		overflow: hidden;
		width: 100%;
		border-radius: 6px;
		/* Dark recessed panel with a bezel, like the physical board. */
		background: #07070a;
		border: 1px solid #26262e;
		box-shadow:
			inset 0 2px 10px rgba(0, 0, 0, 0.9),
			0 1px 3px rgba(0, 0, 0, 0.35);
		padding: 10px 0;
	}

	/* The LED grid itself: opaque panel colour everywhere EXCEPT a lattice of
	   small holes. It sits ON TOP of the text, so both lit glyphs and dark
	   background get chopped into the same uniform dot pitch — which is how a
	   physical board works, the diodes are fixed and the message slides
	   through them. Doing it here rather than masking each glyph also means
	   nothing has to align with the font's pixel grid, and the dots can't
	   shimmer against the letters as they scroll. */
	.ticker__glass {
		position: absolute;
		inset: 0;
		/* Hole radius ~1px on a 3px pitch leaves roughly a third of the panel
		   open — close to the fill factor of a real board. Smaller reads as a
		   screen door over the text; larger loses the dot structure. */
		background-image: radial-gradient(circle at center, transparent 0 1px, #07070a 1.3px 100%);
		background-size: var(--led-pitch) var(--led-pitch);
		pointer-events: none;
		z-index: 2;
	}

	/* Both ends fade into the bezel so cells enter and leave instead of
	   popping at a hard edge. */
	.ticker::after {
		content: '';
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 3;
		background: linear-gradient(
			90deg,
			#07070a 0%,
			transparent 6%,
			transparent 94%,
			#07070a 100%
		);
	}

	.ticker__track {
		display: flex;
		width: max-content;
		animation: ticker-scroll var(--ticker-duration) linear infinite;
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
		gap: 6px;
		padding: 0 2.5rem;
		white-space: nowrap;
		/* Blocky bitmap glyphs survive being chopped into dots; a smooth
		   typeface would come out as mush at this pitch. */
		font-family: 'Silkscreen', 'Courier New', monospace;
	}

	.cell__name {
		font-size: calc(var(--glyph-px) * 10);
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #eaf2ff;
		text-shadow:
			0 0 4px rgba(190, 220, 255, 0.85),
			0 0 12px rgba(120, 170, 255, 0.5);
	}

	.cell__doors {
		font-size: calc(var(--glyph-px) * 10);
		font-weight: 700;
		letter-spacing: 0.04em;
		/* Green for the counts, matching the up-ticks on a stock board. */
		color: #3dff85;
		text-shadow:
			0 0 5px rgba(61, 255, 133, 0.9),
			0 0 16px rgba(61, 255, 133, 0.45);
	}
	/* Three quarters of the shared glyph size, so the word stays subordinate
	   to the number it labels while still scaling with the board. */
	.cell__unit {
		font-size: calc(var(--glyph-px) * 10 * 0.75);
		opacity: 0.7;
		margin-left: 0.3em;
	}

	/* Day's leader burns amber, the way a board highlights the mover. */
	.cell--lead .cell__name {
		color: #ffd98a;
		text-shadow:
			0 0 4px rgba(255, 200, 110, 0.9),
			0 0 14px rgba(255, 170, 60, 0.55);
	}
	.cell--lead .cell__doors {
		color: #ffb02e;
		text-shadow:
			0 0 6px rgba(255, 176, 46, 0.95),
			0 0 18px rgba(255, 140, 20, 0.5);
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

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
	<!-- The whole board is aria-hidden: it's a moving target, it renders the
	     list twice for the seamless loop, and the sr-only list below carries
	     the same information in a readable form. -->
	<div class="ticker" style={durationStyle} aria-hidden="true">
		<p class="ticker__header">Most doors knocked today:</p>
		<div class="ticker__track">
			{#each [0, 1] as copy (copy)}
				<div class="ticker__strip">
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

	<ol class="ticker__sr" aria-label="Most doors knocked today">
		{#each entries as entry (entry.canvasser)}
			<li>{entry.canvasser}: {entry.doors} doors knocked</li>
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
		background: linear-gradient(
			90deg,
			#07070a 0%,
			transparent 6%,
			transparent 94%,
			#07070a 100%
		);
	}

	/* Static caption line, the way a real board holds a fixed label above the
	   scrolling message. It sits under the board's diode grid like everything
	   else, so it reads as part of the sign rather than as a caption on top
	   of one. */
	.ticker__header {
		margin: 0 0 8px;
		text-align: center;
		font-family: 'Silkscreen', 'Courier New', monospace;
		font-size: calc(var(--glyph-px, 2.5px) * 10 * 0.75);
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
		font-size: calc(var(--glyph-px, 2.5px) * 10);
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #eaf2ff;
		text-shadow:
			0 0 4px rgba(190, 220, 255, 0.85),
			0 0 12px rgba(120, 170, 255, 0.5);
	}

	.cell__doors {
		font-size: calc(var(--glyph-px, 2.5px) * 10);
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
		font-size: calc(var(--glyph-px, 2.5px) * 10 * 0.75);
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

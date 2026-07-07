<script lang="ts">
	import { countdownParts } from './countdown.js';

	interface Props {
		/** Admin-configured caption; '' hides the label line. */
		label: string;
		/** ISO datetime the countdown ends at. */
		endAt: string;
	}

	let { label, endAt }: Props = $props();

	const endMs = $derived(Date.parse(endAt));

	let now = $state(Date.now());

	// Minute-precision display, so a 1s tick only touches the DOM at minute
	// rollovers — the derived text stays referentially equal in between.
	$effect(() => {
		const id = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(id);
	});

	const parts = $derived(countdownParts(endMs, now));
	const pad = (n: number) => String(n).padStart(2, '0');
</script>

{#if !Number.isNaN(endMs)}
	<div
		class="countdown"
		class:expired={parts.expired}
		role="timer"
		aria-live="off"
		aria-label="{label || 'Countdown'}: {parts.days} days {parts.hours} hours {parts.minutes} minutes remaining"
	>
		{#if label}
			<span class="countdown-label">{label}</span>
		{/if}
		<span class="countdown-time" aria-hidden="true">
			{parts.days}<span class="countdown-unit">d</span>
			{pad(parts.hours)}<span class="countdown-unit">h</span>
			{pad(parts.minutes)}<span class="countdown-unit">m</span>
		</span>
	</div>
{/if}

<style>
	.countdown {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		color: var(--color-gold);
		line-height: 1;
	}
	/* The LCD face is for the digits only — the label reads in the app font. */
	.countdown-label {
		font-size: 0.7rem;
		letter-spacing: 0.08em;
		color: rgba(251, 240, 228, 0.75);
		max-width: 320px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.countdown-time {
		font-family: 'LCD14', 'Courier New', monospace;
		font-size: 1.4rem;
		white-space: nowrap;
	}
	.countdown-unit {
		font-size: 0.8rem;
		margin-right: 0.25em;
		color: rgba(251, 240, 228, 0.6);
	}
	.countdown.expired .countdown-time {
		color: var(--color-coral);
	}
</style>

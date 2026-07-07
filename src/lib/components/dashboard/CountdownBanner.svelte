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
		class="countdown-banner"
		class:expired={parts.expired}
		role="timer"
		aria-live="off"
		aria-label="{label || 'Countdown'}: {parts.days} days {parts.hours} hours {parts.minutes} minutes {parts.seconds} seconds remaining"
	>
		{#if label}
			<span class="countdown-label">{label}</span>
		{/if}
		<span class="countdown-time" aria-hidden="true">
			{parts.days}<span class="countdown-unit">d</span>
			{pad(parts.hours)}<span class="countdown-unit">h</span>
			{pad(parts.minutes)}<span class="countdown-unit">m</span>
			{pad(parts.seconds)}<span class="countdown-unit">s</span>
		</span>
	</div>
{/if}

<style>
	.countdown-banner {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 8px 0;
		color: var(--color-red);
		line-height: 1;
	}
	/* The LCD face is for the digits only — the label reads in the app font. */
	.countdown-label {
		font-family: var(--font-family);
		font-size: 2rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-align: center;
	}
	.countdown-time {
		font-family: 'LCD14', 'Courier New', monospace;
		font-size: clamp(2rem, 6vw, 3.5rem);
		white-space: nowrap;
	}
	.countdown-unit {
		font-size: 0.45em;
		margin-right: 0.3em;
		opacity: 0.65;
	}
</style>

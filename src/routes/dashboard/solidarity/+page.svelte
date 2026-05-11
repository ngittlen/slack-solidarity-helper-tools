<script lang="ts">
	import RangePresetPicker from '$lib/components/dashboard/RangePresetPicker.svelte';
	import ChartCard from '$lib/components/dashboard/ChartCard.svelte';
	import { buildDetailFrame } from '$lib/components/dashboard/chart-data.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const cardState = $derived.by<
		| { kind: 'empty' }
		| { kind: 'error'; message: string }
		| { kind: 'ready'; frame: ReturnType<typeof buildDetailFrame>; showTotalOverlay: boolean }
	>(() => {
		if (!data.solidarity.ok) {
			return { kind: 'error', message: data.solidarity.error };
		}
		const frame = buildDetailFrame(data.solidarity.days);
		if (frame.dates.length === 0) return { kind: 'empty' };
		return { kind: 'ready', frame, showTotalOverlay: true };
	});
</script>

<svelte:head>
	<title>Solidarity signups by chapter</title>
</svelte:head>

<main>
	<div class="detail-header">
		<RangePresetPicker current={data.days} />
	</div>

	<ChartCard title="Solidarity signups" cardState={cardState} />

	<p class="legend-note">
		Members in multiple chapters are counted in each band but only once in the daily total
		(shown as the dark marker on each bar).
	</p>

	<p class="back-link">
		<!-- Same-host, known route + query string. -->
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a href={`/?days=${data.days}`}>← Back</a>
	</p>
</main>

<style>
	main {
		font-family: var(--font-family);
		max-width: 1100px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
		color: var(--color-text);
	}
	.detail-header {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 1.5rem;
	}
	.legend-note {
		color: var(--color-text-muted);
		font-size: var(--font-size-md);
		margin: -0.5rem 0 1rem;
	}
	.back-link a {
		color: var(--color-action);
		text-decoration: none;
	}
	.back-link a:hover,
	.back-link a:focus-visible {
		text-decoration: underline;
	}
	@media (max-width: 640px) {
		main {
			padding: 1rem;
		}
	}
</style>

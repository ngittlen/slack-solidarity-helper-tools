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
		if (!data.slack.ok) {
			return { kind: 'error', message: data.slack.error };
		}
		const frame = buildDetailFrame(data.slack.days, 'slack');
		if (frame.dates.length === 0) return { kind: 'empty' };
		return { kind: 'ready', frame, showTotalOverlay: true };
	});
</script>

<svelte:head>
	<title>Slack signups by chapter</title>
</svelte:head>

<main>
	<header class="detail-header">
		<h1>Slack signups by chapter</h1>
		<RangePresetPicker current={data.days} />
	</header>

	<ChartCard title="Slack signups" cardState={cardState} />

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
		font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
		max-width: 1100px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}
	.detail-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	.detail-header h1 {
		margin: 0;
		font-size: 1.5rem;
		color: #111827;
	}
	.legend-note {
		color: #6b7280;
		font-size: 0.9rem;
		margin: -0.5rem 0 1rem;
	}
	.back-link a {
		color: #2563eb;
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

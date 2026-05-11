<script lang="ts">
	import RangePresetPicker from '$lib/components/dashboard/RangePresetPicker.svelte';
	import ChartCard from '$lib/components/dashboard/ChartCard.svelte';
	import { buildOverviewFrame } from '$lib/components/dashboard/chart-data.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const solidarityState = $derived.by<
		| { kind: 'empty' }
		| { kind: 'error'; message: string }
		| { kind: 'ready'; frame: ReturnType<typeof buildOverviewFrame> }
	>(() => {
		if (!data.solidarity.ok) {
			return { kind: 'error', message: data.solidarity.error };
		}
		const frame = buildOverviewFrame(data.solidarity.days, 'Solidarity');
		if (frame.dates.length === 0) return { kind: 'empty' };
		return { kind: 'ready', frame };
	});

	const slackState = $derived.by<
		| { kind: 'empty' }
		| { kind: 'error'; message: string }
		| { kind: 'ready'; frame: ReturnType<typeof buildOverviewFrame> }
	>(() => {
		if (!data.slack.ok) {
			return { kind: 'error', message: data.slack.error };
		}
		const frame = buildOverviewFrame(data.slack.days, 'Slack');
		if (frame.dates.length === 0) return { kind: 'empty' };
		return { kind: 'ready', frame };
	});
</script>

<svelte:head>
	<title>Dashboard</title>
</svelte:head>

<main>
	<div class="dashboard-toolbar">
		<RangePresetPicker current={data.days} />
	</div>

	<ChartCard
		title="Solidarity signups"
		detailHref={`/dashboard/solidarity?days=${data.days}`}
		cardState={solidarityState}
	/>

	<ChartCard
		title="Slack signups"
		detailHref={`/dashboard/slack?days=${data.days}`}
		cardState={slackState}
	/>
</main>

<style>
	main {
		font-family: var(--font-family);
		max-width: 960px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
		color: var(--color-text);
	}
	.dashboard-toolbar {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 1.5rem;
	}
	@media (max-width: 640px) {
		main {
			padding: 1rem;
		}
	}
</style>

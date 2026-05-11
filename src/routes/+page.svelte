<script lang="ts">
	import { resolve } from '$app/paths';
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
	<header class="dashboard-header">
		<h1>Hi, {data.userName}</h1>
		<RangePresetPicker current={data.days} />
	</header>

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

	<footer class="dashboard-footer">
		{#if data.isAdmin}
			<p><a href={resolve('/pending')}>Pending applicants</a></p>
		{/if}
		<form method="POST" action="/auth/logout">
			<button type="submit">Sign out</button>
		</form>
	</footer>
</main>

<style>
	main {
		font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
		max-width: 960px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}
	.dashboard-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	.dashboard-header h1 {
		margin: 0;
		font-size: 1.5rem;
		color: #111827;
	}
	.dashboard-footer {
		margin-top: 2rem;
		padding-top: 1.5rem;
		border-top: 1px solid #e5e7eb;
	}
	.dashboard-footer button {
		appearance: none;
		background: transparent;
		border: 1px solid #d0d5dd;
		padding: 0.5rem 1rem;
		font: inherit;
		border-radius: 6px;
		cursor: pointer;
	}
	@media (max-width: 640px) {
		main {
			padding: 1rem;
		}
	}
</style>

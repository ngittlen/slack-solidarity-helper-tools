<script lang="ts">
	import RangePresetPicker from '$lib/components/dashboard/RangePresetPicker.svelte';
	import CountdownBanner from '$lib/components/dashboard/CountdownBanner.svelte';
	import ChartCard from '$lib/components/dashboard/ChartCard.svelte';
	import SlackLeaderboard from '$lib/components/dashboard/SlackLeaderboard.svelte';
	import {
		buildOverviewFrame,
		buildDetailFrame,
		type ChartBand,
		type ChartFrame,
	} from '$lib/components/dashboard/chart-data.js';
	import type { DaySignups } from '$lib/server/dashboard-signups.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type ChartMode = 'overview' | 'detail';
	type CardState =
		| { kind: 'empty' }
		| { kind: 'error'; message: string }
		| {
				kind: 'ready';
				frame: ChartFrame;
				showTotalOverlay: boolean;
				legendBands: ChartBand[];
		  };

	let solidarityMode = $state<ChartMode>('overview');
	let slackMode = $state<ChartMode>('overview');
	let doorKnockMode = $state<ChartMode>('detail');

	function buildState(
		source: { ok: true; days: DaySignups[] } | { ok: false; error: string },
		mode: ChartMode,
		label: string,
	): CardState {
		if (!source.ok) return { kind: 'error', message: source.error };
		// Always build the detail frame: even in overview mode its band list
		// feeds the reserved-but-hidden legend, so toggling never resizes the card.
		const detailFrame = buildDetailFrame(source.days);
		const frame = mode === 'detail' ? detailFrame : buildOverviewFrame(source.days, label);
		if (frame.dates.length === 0) return { kind: 'empty' };
		return {
			kind: 'ready',
			frame,
			showTotalOverlay: mode === 'detail',
			legendBands: detailFrame.bands,
		};
	}

	const solidarityState = $derived(buildState(data.solidarity, solidarityMode, 'Solidarity'));
	const slackState = $derived(buildState(data.slack, slackMode, 'Slack'));
	const doorKnockState = $derived(buildState(data.doorKnock, doorKnockMode, 'Doors'));

	// The door-knock card only appears once the nightly Openfield snapshot has
	// ever written data (or on a load error) — hidden entirely while the
	// integration is unconfigured, rather than showing a permanent empty card.
	const showDoorKnock = $derived(data.doorKnock.ok === false || doorKnockState.kind !== 'empty');
</script>

<svelte:head>
	<title>Dashboard</title>
</svelte:head>

<main>
	{#if data.countdown}
		<div class="countdown-row">
			<CountdownBanner
				label={data.countdown.label}
				endAt={data.countdown.endAt}
				projectedDoors={data.countdown.projectedDoors}
			/>
		</div>
	{/if}

	<div class="dashboard-toolbar">
		<RangePresetPicker current={data.days} />
	</div>

	<ChartCard title="Solidarity signups" cardState={solidarityState} bind:mode={solidarityMode} />

	<div class="slack-row">
		<ChartCard title="Slack signups" cardState={slackState} bind:mode={slackMode} />
		<SlackLeaderboard leaderboard={data.leaderboard} />
	</div>

	{#if showDoorKnock}
		<div class="door-knock-row">
			<ChartCard title="Doors knocked" cardState={doorKnockState} bind:mode={doorKnockMode} />
		</div>
	{/if}
</main>

<style>
	main {
		font-family: var(--font-family);
		max-width: 1280px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
		color: var(--color-text);
	}
	.countdown-row {
		margin-bottom: 1.5rem;
	}
	.dashboard-toolbar {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 1.5rem;
	}
	.slack-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		gap: 1.5rem;
		align-items: start;
	}
	.door-knock-row {
		margin-top: 1.5rem;
	}
	@media (max-width: 960px) {
		.slack-row {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 640px) {
		main {
			padding: 1rem;
		}
	}
</style>

<script lang="ts">
	import { invalidate } from '$app/navigation';
	import type { ChartFrame } from './chart-data.js';
	import SignupChart from './SignupChart.svelte';

	type CardState =
		| { kind: 'loading' }
		| { kind: 'empty' }
		| { kind: 'error'; message: string }
		| { kind: 'ready'; frame: ChartFrame; showTotalOverlay?: boolean };

	type Props = {
		title: string;
		detailHref?: string;
		cardState: CardState;
	};

	let { title, detailHref, cardState }: Props = $props();

	let isRetrying = $state(false);

	const headingId = $derived(
		'chart-card-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
	);

	const displayState = $derived<CardState>(isRetrying ? { kind: 'loading' } : cardState);

	async function handleRetry() {
		isRetrying = true;
		try {
			await invalidate('app:dashboard');
		} finally {
			isRetrying = false;
		}
	}
</script>

<section class="chart-card" aria-labelledby={headingId}>
	<h2 class="chart-card__title" id={headingId}>{title}</h2>
	<div class="chart-card__body">
		{#if displayState.kind === 'loading'}
			<div class="chart-card__loading" role="status" aria-label="Loading">
				<span class="chart-card__loading-bar" aria-hidden="true"></span>
			</div>
		{:else if displayState.kind === 'empty'}
			<p class="chart-card__empty">No signups recorded yet</p>
		{:else if displayState.kind === 'error'}
			<p class="chart-card__error">{displayState.message}</p>
			<button type="button" class="chart-card__retry" onclick={handleRetry}>Retry</button>
		{:else}
			<SignupChart
				variant={detailHref ? 'overview' : 'detail'}
				frame={displayState.frame}
				accessibleName={title}
				showTotalOverlay={displayState.showTotalOverlay ?? false}
			/>
			<table class="chart-card__sr-table">
				<caption>{title}</caption>
				<thead>
					<tr>
						<th scope="col">Date</th>
						{#each displayState.frame.bands as band (band.key)}
							<th scope="col">{band.label}</th>
						{/each}
						{#if displayState.frame.dailyTotals}
							<th scope="col">Daily distinct total</th>
						{/if}
					</tr>
				</thead>
				<tbody>
					{#each displayState.frame.dates as date, i (date)}
						<tr>
							<th scope="row">{date}</th>
							{#each displayState.frame.bands as band (band.key)}
								<td>{band.values[i] ?? 0}</td>
							{/each}
							{#if displayState.frame.dailyTotals}
								<td>{displayState.frame.dailyTotals[i] ?? 0}</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
	{#if detailHref && displayState.kind === 'ready'}
		<!-- detailHref is constructed by the parent page from a known route + query string. -->
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a class="chart-card__detail" href={detailHref}>View by chapter →</a>
	{/if}
</section>

<style>
	.chart-card {
		background: white;
		border: 1px solid #e5e7eb;
		border-radius: 12px;
		padding: 1.25rem 1.5rem;
		margin: 1rem 0;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
	}
	.chart-card__title {
		margin: 0 0 0.75rem;
		font-size: 1.125rem;
		color: #111827;
	}
	.chart-card__body {
		position: relative;
		min-height: 200px;
	}
	.chart-card__loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 3rem 0;
	}
	.chart-card__loading-bar {
		display: block;
		width: 60%;
		height: 3px;
		background: linear-gradient(90deg, transparent, #2563eb, transparent);
		background-size: 200% 100%;
		animation: chart-card-shimmer 1.4s linear infinite;
	}
	@keyframes chart-card-shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
	.chart-card__empty,
	.chart-card__error {
		color: #6b7280;
		padding: 3rem 0;
		text-align: center;
		margin: 0;
	}
	.chart-card__error {
		color: #b91c1c;
	}
	.chart-card__retry {
		display: block;
		margin: 0 auto;
		appearance: none;
		background: #1f2937;
		color: white;
		border: 0;
		padding: 0.5rem 1.25rem;
		border-radius: 8px;
		cursor: pointer;
		font: inherit;
	}
	.chart-card__retry:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
	}
	.chart-card__detail {
		display: inline-block;
		margin-top: 0.75rem;
		color: #2563eb;
		text-decoration: none;
		font-weight: 500;
	}
	.chart-card__detail:hover,
	.chart-card__detail:focus-visible {
		text-decoration: underline;
		outline: none;
	}
	.chart-card__sr-table {
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

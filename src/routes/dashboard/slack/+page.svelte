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
		const frame = buildDetailFrame(data.slack.days);
		if (frame.dates.length === 0) return { kind: 'empty' };
		return { kind: 'ready', frame, showTotalOverlay: true };
	});

	function fmtPct(p: number): string {
		return `${Math.round(p * 10) / 10}%`;
	}

	function fmtDate(iso: string): string {
		return iso.slice(0, 10);
	}
</script>

<svelte:head>
	<title>Slack signups by chapter</title>
</svelte:head>

<main>
	<div class="detail-header">
		<RangePresetPicker current={data.days} />
	</div>

	<div class="slack-detail-layout">
		<div class="slack-detail-main">
			<ChartCard title="Slack signups" cardState={cardState} />
			<p class="legend-note">
				Members in multiple chapters are counted in each band but only once in the daily total
				(shown as the dark marker on each bar).
			</p>
		</div>

		<aside class="leaderboard" aria-labelledby="leaderboard-heading">
			<h2 id="leaderboard-heading" class="leaderboard__title">This week's Slack leaderboard</h2>
			{#if data.leaderboard.ok}
				{@const lb = data.leaderboard.leaderboard}
				<p class="leaderboard__window">
					{fmtDate(lb.windowStart)} → {fmtDate(lb.windowEnd)}
				</p>
				<p class="leaderboard__total">
					<strong>{lb.totalNewJoins}</strong>
					new {lb.totalNewJoins === 1 ? 'member' : 'members'} joined Slack this week
				</p>
				{#if lb.topChapters.length === 0}
					<p class="leaderboard__empty">No new signups this week.</p>
				{:else}
					<ol class="leaderboard__list">
						{#each lb.topChapters as entry, i (entry.chapterId)}
							<li class="leaderboard__row" class:winner={i === 0}>
								<div class="leaderboard__rank">
									{i === 0 ? '🏆' : `#${i + 1}`}
								</div>
								<div class="leaderboard__details">
									<div class="leaderboard__chapter">{entry.chapterName}</div>
									<div class="leaderboard__metrics">
										<span class="leaderboard__metric">
											<strong>+{entry.newJoins}</strong> new
										</span>
										<span class="leaderboard__sep">·</span>
										{#if entry.existing > 0}
											<span class="leaderboard__metric">
												<strong>{fmtPct(entry.pct)}</strong> growth
											</span>
											<span class="leaderboard__sep">·</span>
											<span class="leaderboard__metric leaderboard__existing">
												{entry.existing} existing
											</span>
										{:else}
											<span class="leaderboard__metric leaderboard__brand-new">
												brand new on Slack
											</span>
										{/if}
									</div>
								</div>
							</li>
						{/each}
					</ol>
				{/if}
			{:else}
				<p class="leaderboard__error">{data.leaderboard.error}</p>
			{/if}
		</aside>
	</div>

	<p class="back-link">
		<!-- Same-host, known route + query string. -->
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a href={`/?days=${data.days}`}>← Back</a>
	</p>
</main>

<style>
	main {
		font-family: var(--font-family);
		max-width: 1280px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
		color: var(--color-text);
	}
	.detail-header {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 1.5rem;
	}
	.slack-detail-layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 320px;
		gap: 1.5rem;
		align-items: start;
	}
	.slack-detail-main {
		min-width: 0;
	}
	.legend-note {
		color: var(--color-text-muted);
		font-size: var(--font-size-md);
		margin: -0.5rem 0 0;
	}
	.leaderboard {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: 1.25rem 1.5rem;
		box-shadow: 0 1px 2px rgba(18, 28, 80, 0.06);
		margin-top: 1rem;
	}
	.leaderboard__title {
		margin: 0 0 0.25rem;
		font-size: 1rem;
		color: var(--color-text);
	}
	.leaderboard__window {
		margin: 0 0 0.75rem;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}
	.leaderboard__total {
		margin: 0 0 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--color-border-subtle);
		font-size: var(--font-size-md);
		color: var(--color-text-muted);
	}
	.leaderboard__total strong {
		color: var(--color-text);
	}
	.leaderboard__empty,
	.leaderboard__error {
		color: var(--color-text-muted);
		font-size: var(--font-size-md);
		margin: 0;
	}
	.leaderboard__error {
		color: var(--color-error);
	}
	.leaderboard__list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.leaderboard__row {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
	}
	.leaderboard__row.winner .leaderboard__chapter {
		font-weight: 600;
		color: var(--color-text);
	}
	.leaderboard__rank {
		flex-shrink: 0;
		width: 1.75rem;
		font-weight: 600;
		font-size: var(--font-size-base);
		color: var(--color-text-muted);
		padding-top: 1px;
	}
	.leaderboard__row.winner .leaderboard__rank {
		font-size: 1.1rem;
		padding-top: 0;
	}
	.leaderboard__details {
		flex: 1;
		min-width: 0;
	}
	.leaderboard__chapter {
		font-size: var(--font-size-lg);
		color: var(--color-text);
		overflow-wrap: anywhere;
	}
	.leaderboard__metrics {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		align-items: baseline;
	}
	.leaderboard__metric strong {
		color: var(--color-text);
	}
	.leaderboard__sep {
		color: var(--color-text-faint);
	}
	.leaderboard__brand-new {
		font-style: italic;
	}
	.back-link {
		margin-top: 1.5rem;
	}
	.back-link a {
		color: var(--color-action);
		text-decoration: none;
	}
	.back-link a:hover,
	.back-link a:focus-visible {
		text-decoration: underline;
	}
	@media (max-width: 960px) {
		.slack-detail-layout {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 640px) {
		main {
			padding: 1rem;
		}
	}
</style>

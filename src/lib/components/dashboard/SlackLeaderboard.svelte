<script lang="ts">
	import type { LeaderboardPair } from '$lib/server/weekly-growth-report';

	type Props = { leaderboard: LeaderboardPair };
	let { leaderboard }: Props = $props();

	type LeaderboardTab = 'lastWeek' | 'thisWeek';
	let tab = $state<LeaderboardTab>('thisWeek');
	const activeLb = $derived(tab === 'lastWeek' ? leaderboard.saved : leaderboard.live);

	function fmtPct(p: number): string {
		return `${Math.round(p * 10) / 10}%`;
	}

	function fmtDate(iso: string): string {
		return iso.slice(0, 10);
	}
</script>

<aside class="leaderboard" aria-labelledby="leaderboard-heading">
	<h2 id="leaderboard-heading" class="leaderboard__title">Slack leaderboard</h2>
	<div class="leaderboard__tabs" role="group" aria-label="Leaderboard window">
		<button
			type="button"
			class="leaderboard__tab"
			class:active={tab === 'thisWeek'}
			aria-pressed={tab === 'thisWeek'}
			onclick={() => (tab = 'thisWeek')}
		>
			This week so far
		</button>
		<button
			type="button"
			class="leaderboard__tab"
			class:active={tab === 'lastWeek'}
			aria-pressed={tab === 'lastWeek'}
			onclick={() => (tab = 'lastWeek')}
		>
			Last week
		</button>
	</div>
	{#if activeLb.ok}
		{@const lb = activeLb.leaderboard}
		<p class="leaderboard__window">
			{fmtDate(lb.windowStart)} → {fmtDate(lb.windowEnd)}
		</p>
		<p class="leaderboard__total">
			<strong>{lb.totalNewJoins}</strong>
			new {lb.totalNewJoins === 1 ? 'member' : 'members'} joined Slack
			{tab === 'lastWeek' ? 'that week' : 'so far this week'}
		</p>
		{#if lb.topChapters.length === 0}
			<p class="leaderboard__empty">
				{tab === 'lastWeek'
					? 'No new signups this week.'
					: 'No new signups yet this week.'}
			</p>
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
		<p class="leaderboard__error">{activeLb.error}</p>
	{/if}
</aside>

<style>
	.leaderboard {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: 1.25rem 1.5rem;
		box-shadow: 0 1px 2px rgba(18, 28, 80, 0.06);
		margin-top: 1rem;
	}
	.leaderboard__title {
		margin: 0 0 0.6rem;
		font-size: 1rem;
		color: var(--color-text);
	}
	.leaderboard__tabs {
		display: inline-flex;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		background: var(--color-surface);
		margin: 0 0 0.75rem;
	}
	.leaderboard__tab {
		appearance: none;
		background: transparent;
		border: 0;
		padding: 0.35rem 0.75rem;
		font: inherit;
		font-size: var(--font-size-sm);
		color: var(--color-text);
		cursor: pointer;
		border-right: 1px solid var(--color-border);
	}
	.leaderboard__tab:last-child {
		border-right: 0;
	}
	.leaderboard__tab:hover:not(.active) {
		background: var(--color-border-subtle);
	}
	.leaderboard__tab.active {
		background: var(--color-action);
		color: var(--color-action-text);
	}
	.leaderboard__tab:focus-visible {
		outline: 2px solid var(--color-blue);
		outline-offset: 2px;
		position: relative;
		z-index: 1;
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
</style>

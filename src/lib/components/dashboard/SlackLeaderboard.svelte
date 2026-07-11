<script lang="ts">
	import type { LeaderboardPair, WeeklyLeaderboard, ChapterGrowth } from '$lib/server/weekly-growth-report';
	import LeaderboardCard, { type LeaderboardTab } from './LeaderboardCard.svelte';

	type Props = { leaderboard: LeaderboardPair };
	let { leaderboard }: Props = $props();

	function fmtPct(p: number): string {
		return `${Math.round(p * 10) / 10}%`;
	}
</script>

{#snippet total(lb: WeeklyLeaderboard, tab: LeaderboardTab)}
	<strong>{lb.totalNewJoins}</strong>
	new {lb.totalNewJoins === 1 ? 'member' : 'members'} joined Slack
	{tab === 'lastWeek' ? 'that week' : 'so far this week'}
{/snippet}

{#snippet empty(tab: LeaderboardTab)}
	{tab === 'lastWeek' ? 'No new signups this week.' : 'No new signups yet this week.'}
{/snippet}

{#snippet metrics(entry: ChapterGrowth)}
	<span>
		<strong>+{entry.newJoins}</strong> new
	</span>
	<span class="leaderboard__sep">·</span>
	{#if entry.existing > 0}
		<span>
			<strong>{fmtPct(entry.pct)}</strong> growth
		</span>
		<span class="leaderboard__sep">·</span>
		<span>{entry.existing} existing</span>
	{:else}
		<span class="leaderboard__note">brand new on Slack</span>
	{/if}
{/snippet}

<LeaderboardCard
	title="Slack leaderboard"
	thisWeek={leaderboard.live}
	lastWeek={leaderboard.saved}
	entriesOf={(lb) => lb.topChapters}
	rowKey={(entry) => entry.chapterId}
	rowName={(entry) => entry.chapterName}
	{total}
	{empty}
	{metrics}
/>

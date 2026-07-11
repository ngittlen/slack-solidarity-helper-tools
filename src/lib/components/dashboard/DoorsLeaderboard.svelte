<script lang="ts">
	import type {
		DoorsLeaderboardPair,
		DoorsLeaderboard,
		DoorsChapterEntry,
	} from '$lib/server/door-knock-leaderboard';
	import LeaderboardCard, { type LeaderboardTab } from './LeaderboardCard.svelte';

	type Props = { leaderboard: DoorsLeaderboardPair };
	let { leaderboard }: Props = $props();

	function fmtPct(p: number): string {
		const rounded = Math.round(Math.abs(p) * 10) / 10;
		return `${p >= 0 ? '↑' : '↓'}${rounded}%`;
	}
</script>

{#snippet total(lb: DoorsLeaderboard, tab: LeaderboardTab)}
	<strong>{lb.totalDoors.toLocaleString('en-US')}</strong>
	{lb.totalDoors === 1 ? 'door' : 'doors'} knocked
	{tab === 'lastWeek' ? 'that week' : 'so far this week'}
{/snippet}

{#snippet empty(tab: LeaderboardTab)}
	{tab === 'lastWeek' ? 'No doors knocked that week.' : 'No doors knocked yet this week.'}
{/snippet}

{#snippet metrics(entry: DoorsChapterEntry)}
	<span>
		<strong>+{entry.doors.toLocaleString('en-US')}</strong> doors
	</span>
	<span class="leaderboard__sep">·</span>
	{#if entry.prevDoors > 0}
		<span>
			<strong>{fmtPct(entry.pct)}</strong> vs last week
		</span>
		<span class="leaderboard__sep">·</span>
		<span>{entry.prevDoors.toLocaleString('en-US')} last week</span>
	{:else}
		<span class="leaderboard__note">first week knocking</span>
	{/if}
{/snippet}

<LeaderboardCard
	title="Canvassing leaderboard"
	thisWeek={leaderboard.thisWeek}
	lastWeek={leaderboard.lastWeek}
	entriesOf={(lb) => lb.topChapters}
	rowKey={(entry) => entry.chapterName}
	rowName={(entry) => entry.chapterName}
	{total}
	{empty}
	{metrics}
/>

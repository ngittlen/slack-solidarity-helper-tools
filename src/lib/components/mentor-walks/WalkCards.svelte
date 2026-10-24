<script lang="ts">
	// The mentor-walk cards on /turfs (specs/015-mentor-walks, User Story 3,
	// FR-015/FR-016): walks in the chapter on screen starting within the next
	// 3 days, soonest first, or nearest first when the viewer's location is
	// known.

	import type { Snippet } from 'svelte';
	import './mentor-walks.css';
	import { distanceLabel, milesBetween } from '$lib/mentor-walks/rules.js';
	import type { WalkCardView } from '$lib/mentor-walks/types.js';
	import WalkCard from './WalkCard.svelte';

	interface Props {
		walks: WalkCardView[];
		chapterName: string;
		location?: { lat: number; lng: number } | null;
		onjoin: (id: string) => Promise<unknown>;
		onleave: (id: string) => Promise<unknown>;
		/** Below the cards (or the empty state): the way to nearby-walk alerts. */
		footer?: Snippet;
	}

	let { walks, chapterName, location = null, onjoin, onleave, footer }: Props = $props();

	const shown = $derived.by(() => {
		if (!location) return walks.map((walk) => ({ walk, miles: null }));
		return walks
			.map((walk) => ({ walk, miles: milesBetween(location, walk.point) }))
			.sort((a, b) => a.miles - b.miles);
	});
</script>

<section class="mw-cards" aria-labelledby="mw-cards-heading">
	<h2 id="mw-cards-heading">Mentor walks in {chapterName}</h2>
	{#if walks.length === 0}
		<p class="mw-panel">No mentor walks in the next 3 days.</p>
	{:else}
		<ul class="mw-list mw-card-grid">
			{#each shown as { walk, miles } (walk.id)}
				<li>
					<WalkCard
						{walk}
						distanceLabel={miles === null ? null : distanceLabel(miles)}
						{onjoin}
						{onleave}
					/>
				</li>
			{/each}
		</ul>
	{/if}
	{@render footer?.()}
</section>

<style>
	.mw-cards {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.mw-cards h2 {
		margin: 0;
		font-size: var(--font-size-md);
	}

	.mw-card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
		gap: var(--space-3);
	}
</style>

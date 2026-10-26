<script lang="ts">
	// The mentor-walk cards on /turfs (specs/015-mentor-walks, User Story 3,
	// FR-015/FR-016): the next 5 walks in the chapter on screen starting
	// within the next week, soonest first, or nearest first when the viewer's
	// location is known. The cards collapse to their heading unless `open`;
	// the empty state and the alerts footer show either way.

	import type { Snippet } from 'svelte';
	import './mentor-walks.css';
	import { distanceLabel, milesBetween } from '$lib/mentor-walks/rules.js';
	import type { WalkCardView } from '$lib/mentor-walks/types.js';
	import WalkCard from './WalkCard.svelte';
	import SectionToggle from './SectionToggle.svelte';

	interface Props {
		walks: WalkCardView[];
		chapterName: string;
		location?: { lat: number; lng: number } | null;
		onjoin: (id: string) => Promise<unknown>;
		onleave: (id: string) => Promise<unknown>;
		/** Below the cards (or the empty state): the way to nearby-walk alerts. */
		footer?: Snippet;
		/** The walk selected on the map, and a way to select one from its card. */
		selectedId?: string | null;
		onselect?: (id: string) => void;
		/** Whether the cards are showing. Bindable, as a marker opens them. */
		open?: boolean;
	}

	let {
		walks,
		chapterName,
		location = null,
		onjoin,
		onleave,
		footer,
		selectedId = null,
		onselect,
		open = $bindable(false),
	}: Props = $props();

	const shown = $derived.by(() => {
		if (!location) return walks.map((walk) => ({ walk, miles: null }));
		return walks
			.map((walk) => ({ walk, miles: milesBetween(location, walk.point) }))
			.sort((a, b) => a.miles - b.miles);
	});
</script>

<section class="mw-cards" aria-labelledby="mw-cards-heading">
	<SectionToggle
		id="mw-cards-heading"
		label="Mentor walks in {chapterName}"
		count={walks.length}
		controls="mw-card-list"
		bind:open
	/>
	<div id="mw-card-list" hidden={!open && walks.length > 0}>
		{#if walks.length === 0}
			<p class="mw-panel">No mentor walks in the next week.</p>
		{:else if open}
			<ul class="mw-list mw-card-grid">
				{#each shown as { walk, miles } (walk.id)}
					<li>
						<WalkCard
							{walk}
							distanceLabel={miles === null ? null : distanceLabel(miles)}
							{onjoin}
							{onleave}
							selected={walk.id === selectedId}
							{onselect}
						/>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
	{@render footer?.()}
</section>

<style>
	.mw-cards {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
</style>

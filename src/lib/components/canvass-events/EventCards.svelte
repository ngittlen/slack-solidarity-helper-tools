<script lang="ts">
	// The chapter's canvass events on /turfs: Solidarity events carrying the
	// canvass tag, over the week ahead, soonest first, or nearest first when
	// the viewer's location is known. Nothing at all when there are none.
	//
	// Collapsed to its heading until asked for: a busy week's cards would push
	// the turf list off the screen. The heading opens it, and so does tapping
	// a canvass marker on the map, which needs its card shown.

	import '$lib/components/mentor-walks/mentor-walks.css';
	import type { CanvassEventCard } from '$lib/canvass-events/types.js';
	import { distanceLabel, milesBetween } from '$lib/mentor-walks/rules.js';
	import EventCard from './EventCard.svelte';
	import SectionToggle from '$lib/components/mentor-walks/SectionToggle.svelte';

	interface Props {
		events: CanvassEventCard[];
		chapterName: string;
		location?: { lat: number; lng: number } | null;
		/** The event selected on the map, and a way to select one from its card. */
		selectedId?: string | null;
		onselect?: (id: string) => void;
		/** Whether the cards are showing. Bindable, as a marker opens them. */
		open?: boolean;
	}

	let {
		events,
		chapterName,
		location = null,
		selectedId = null,
		onselect,
		open = $bindable(false),
	}: Props = $props();

	const shown = $derived.by(() => {
		if (!location) return events.map((event) => ({ event, miles: null }));
		return events
			.map((event) => ({ event, miles: milesBetween(location, event.point) }))
			.sort((a, b) => a.miles - b.miles);
	});
</script>

{#if events.length > 0}
	<section class="ce-cards" aria-labelledby="ce-cards-heading">
		<SectionToggle
			id="ce-cards-heading"
			label="Canvass events in {chapterName}"
			count={events.length}
			controls="ce-card-list"
			bind:open
		/>
		<div id="ce-card-list" hidden={!open}>
			{#if open}
				<ul class="mw-list mw-card-grid">
					{#each shown as { event, miles } (event.id)}
						<li>
							<EventCard
								{event}
								distanceLabel={miles === null ? null : distanceLabel(miles)}
								selected={event.id === selectedId}
								{onselect}
							/>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>
{/if}

<style>
	.ce-cards {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
</style>

<script lang="ts">
	// One place canvasses meet, from Solidarity, as a card above the turf list:
	// the days it meets, what and where, and a row per time with its own RSVP.
	// Looks like a mentor walk's card (WalkCard) so the two read as one list.
	//
	// No "Add to calendar", unlike a walk: Solidarity counts and contacts
	// people by their RSVP, so the card's one way in is the RSVP.

	import '$lib/components/mentor-walks/mentor-walks.css';
	import type { CanvassEventCard } from '$lib/canvass-events/types.js';

	interface Props {
		event: CanvassEventCard;
		/** "1.2 mi", when the viewer's location is known. */
		distanceLabel?: string | null;
		/** Marked as the place selected on the map. */
		selected?: boolean;
		/** Clicking the card, away from its buttons and links, selects its
		 *  place on the map. */
		onselect?: (id: string) => void;
	}

	let { event, distanceLabel = null, selected = false, onselect }: Props = $props();

	/** Days named in the heading before the rest are counted instead. */
	const DAYS_SHOWN = 3;
	const days = $derived([...new Set(event.sessions.map((s) => s.dayLabel))]);
	const moreDays = $derived(days.length - DAYS_SHOWN);

	// Descriptions are clamped to a few lines until asked for: a card is a
	// glance. "More" is offered only when the clamp actually cuts text off,
	// which depends on the card's width as much as the description's length.
	let expanded = $state(false);
	let cutOff = $state(false);

	/** Attachment on the description: whether the clamp is hiding any of it,
	 *  kept current as the card resizes. Measured only while clamped, since
	 *  the expanded text never overflows. */
	function measureClamp(node: HTMLElement) {
		const measure = () => {
			if (!expanded) cutOff = node.scrollHeight > node.clientHeight + 1;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}

	const headingId = $derived(`ce-card-${event.id}`);

	function select(e: MouseEvent) {
		if ((e.target as Element).closest('button, a')) return;
		onselect?.(event.id);
	}
</script>

<!-- A mouse or tap shortcut, as on a walk's card: the map's marker is the
     keyboard's way to select it, and focus is sent here from the marker. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
	id={`event-${event.id}`}
	class={['mw-card', onselect && 'mw-card-selectable', selected && 'mw-card-selected']}
	aria-labelledby={headingId}
	aria-current={selected ? 'true' : undefined}
	tabindex="-1"
	onclick={onselect ? select : undefined}
>
	<div class="mw-card-top">
		<h3 id={headingId}>
			{days.slice(0, DAYS_SHOWN).join(', ')}
			{#if moreDays > 0}<span class="mw-muted"> +{moreDays} more</span>{/if}
		</h3>
		<span class="mw-chip ce-chip">📣 Canvass</span>
	</div>
	<p><strong>{event.title}</strong></p>
	<p>
		{event.place}
		{#if distanceLabel}<span class="mw-muted"> · {distanceLabel}</span>{/if}
	</p>
	{#if event.description}
		<p class={['mw-muted', 'ce-description', !expanded && 'ce-clamped']} {@attach measureClamp}>
			{event.description}
		</p>
		{#if cutOff || expanded}
			<button
				type="button"
				class="mw-btn mw-btn-link ce-more"
				aria-expanded={expanded}
				onclick={() => (expanded = !expanded)}
			>
				{expanded ? 'Less' : 'More'}
			</button>
		{/if}
	{/if}
	<ul class="ce-sessions" aria-label="Times">
		{#each event.sessions as session (session.id)}
			<li class="ce-session">
				<p class="ce-when">
					<strong>{session.dayLabel}</strong> · {session.timeLabel}
					{#if session.title}<span class="ce-session-title mw-muted">{session.title}</span>{/if}
				</p>
				<!-- eslint-disable svelte/no-navigation-without-resolve -- Solidarity's page, not ours -->
				<a
					class="mw-btn mw-btn-primary ce-btn"
					href={session.rsvpUrl}
					target="_blank"
					rel="noopener"
					aria-label={`RSVP for ${session.dayLabel} at ${session.timeLabel}`}>RSVP</a
				>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			</li>
		{/each}
	</ul>
</article>

<style>
	.ce-chip {
		background: var(--color-gold);
		color: var(--color-near-black);
	}

	/* Kept as typed: organizers write descriptions in paragraphs. */
	.ce-description {
		white-space: pre-line;
	}

	.ce-clamped {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 4;
		line-clamp: 4;
		overflow: hidden;
	}

	.ce-more {
		align-self: flex-start;
		font-size: var(--font-size-sm);
	}

	.ce-sessions {
		display: flex;
		flex-direction: column;
		margin: var(--space-2) 0 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--color-border-subtle);
	}

	/* Time on the left, its RSVP on the right; stacked when the card is too
	   narrow for both. */
	.ce-session {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-1) var(--space-2);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.ce-session:last-child {
		border-bottom: none;
		padding-bottom: 0;
	}

	.ce-when {
		font-size: var(--font-size-sm);
	}

	.ce-session-title {
		display: block;
	}

	/* Several to a card, so smaller than a walk's single Join, while still a
	   comfortable tap. */
	.ce-btn {
		display: inline-flex;
		align-items: center;
		min-height: 36px;
		padding: var(--space-1) var(--space-3);
		font-size: var(--font-size-sm);
		text-decoration: none;
	}
</style>

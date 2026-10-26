<script lang="ts">
	// One mentor walk, as a card above the turf list (specs/015-mentor-walks,
	// User Story 3, FR-016/FR-021).
	//
	// The phone number only ever arrives for someone holding a seat (FR-011):
	// the server leaves it out for everyone else.

	import './mentor-walks.css';
	import { WALK_HOURS } from '$lib/mentor-walks/rules.js';
	import { endSentence } from '$lib/mentor-walks/messages.js';
	import { downloadIcs } from '$lib/ics.js';
	import type { WalkCardView } from '$lib/mentor-walks/types.js';

	interface Props {
		walk: WalkCardView;
		/** "1.2 mi", when the viewer's location is known. */
		distanceLabel?: string | null;
		/** Settles once the server has answered, so the buttons wait. */
		onjoin: (id: string) => Promise<unknown>;
		onleave: (id: string) => Promise<unknown>;
		/** Marked as the walk selected on the map. */
		selected?: boolean;
		/** Clicking the card, away from its buttons and links, selects its
		 *  walk on the map. */
		onselect?: (id: string) => void;
	}

	let { walk, distanceLabel = null, onjoin, onleave, selected = false, onselect }: Props = $props();

	function select(event: MouseEvent) {
		if ((event.target as Element).closest('button, a')) return;
		onselect?.(walk.id);
	}

	const headingId = $derived(`mw-card-${walk.id}`);

	const full = $derived(walk.seatsLeft <= 0 && !walk.joined);
	const mentorFirstName = $derived(walk.mentorName.split(' ')[0]);
	const blockedReason = $derived(
		walk.own ? 'This is your walk.' : walk.started ? 'This walk has started.' : null,
	);

	let confirmingLeave = $state(false);
	let busy = $state(false);

	async function run(action: (id: string) => Promise<unknown>) {
		busy = true;
		try {
			await action(walk.id);
		} finally {
			busy = false;
		}
	}

	function addToCalendar() {
		const start = new Date(walk.startsAt);
		downloadIcs(
			{
				uid: `mentor-walk-${walk.id}@${location.host}`,
				start,
				end: new Date(start.getTime() + WALK_HOURS * 3_600_000),
				summary: `Canvass with ${walk.mentorName}`,
				location: walk.place,
				description: [
					walk.note,
					endSentence(`Look for: ${walk.lookFor}`),
					walk.phone ? `Text ${mentorFirstName} at ${walk.phone}.` : '',
				]
					.filter(Boolean)
					.join(' '),
			},
			'mentor-walk.ics',
		);
	}
</script>

<!-- A mouse or tap shortcut: the map's marker is the keyboard's way to
     select the walk, so the card adds no stop to the tab order. Focusable
     from script all the same, as the marker sends focus here. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
	id={`walk-${walk.id}`}
	class={[
		'mw-card',
		walk.joined && 'mw-card-joined',
		onselect && 'mw-card-selectable',
		selected && 'mw-card-selected',
	]}
	aria-labelledby={headingId}
	aria-current={selected ? 'true' : undefined}
	tabindex="-1"
	onclick={onselect ? select : undefined}
>
	<div class="mw-card-top">
		<h3 id={headingId}>{walk.dayLabel} · {walk.timeLabel}</h3>
		{#if walk.joined}
			<span class="mw-chip mw-chip-success">You're going</span>
		{:else if full}
			<span class="mw-chip">Full</span>
		{:else}
			<span class="mw-chip">{walk.seatsLeft} {walk.seatsLeft === 1 ? 'seat' : 'seats'} left</span>
		{/if}
	</div>
	<p><strong>with {walk.mentorName}</strong></p>
	<p>
		{walk.place}
		{#if distanceLabel}<span class="mw-muted"> · {distanceLabel}</span>{/if}
	</p>
	{#if walk.note}
		<p class="mw-muted">“{walk.note}”</p>
	{/if}
	<p class="mw-look-for">👀 Look for: {walk.lookFor}</p>

	{#if walk.joined}
		<div class="mw-callout">
			{#if walk.phone}
				<p>
					Running late or can't find them?
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an sms: link, not a page -->
					<a href="sms:{walk.phone.replace(/[^\d+]/g, '')}"
						>Text {mentorFirstName} at {walk.phone}</a
					>
				</p>
			{:else}
				<p>The mentor didn't leave a number. Meet at the place above.</p>
			{/if}
		</div>
		{#if walk.started}
			<!-- Nothing to change once it has started (FR-020). -->
		{:else if confirmingLeave}
			<p role="alert">Give up your seat? {mentorFirstName} will be told.</p>
			<div class="mw-actions">
				<button
					type="button"
					class="mw-btn mw-btn-danger"
					disabled={busy}
					onclick={async () => {
						await run(onleave);
						confirmingLeave = false;
					}}
				>
					Yes, give it up
				</button>
				<button type="button" class="mw-btn mw-btn-ghost" onclick={() => (confirmingLeave = false)}>
					Keep my seat
				</button>
			</div>
		{:else}
			<div class="mw-actions">
				<button type="button" class="mw-btn mw-btn-ghost" onclick={addToCalendar}>
					Add to calendar
				</button>
				<button type="button" class="mw-btn mw-btn-link" onclick={() => (confirmingLeave = true)}>
					I can't make it
				</button>
			</div>
		{/if}
	{:else}
		<div class="mw-actions">
			<button
				type="button"
				class="mw-btn mw-btn-primary"
				disabled={busy || full || blockedReason !== null}
				onclick={() => run(onjoin)}
			>
				{full ? 'Full' : busy ? 'Joining…' : 'Join'}
			</button>
		</div>
		{#if blockedReason && !full}
			<p class="mw-muted">{blockedReason}</p>
		{/if}
	{/if}
</article>

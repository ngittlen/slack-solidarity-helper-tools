<script lang="ts">
	// One mentor walk, as a card above the turf list (specs/015-mentor-walks,
	// User Story 3, FR-016/FR-021).
	//
	// The phone number only ever arrives for someone holding a seat (FR-011):
	// the server leaves it out for everyone else.

	import './mentor-walks.css';
	import { WALK_HOURS } from '$lib/mentor-walks/rules.js';
	import { endSentence } from '$lib/mentor-walks/messages.js';
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

	/** iCalendar's UTC form: 20261018T140000Z. */
	function icsTime(date: Date): string {
		return date
			.toISOString()
			.replace(/[-:]/g, '')
			.replace(/\.\d{3}/, '');
	}

	/** Escapes for an iCalendar text value. */
	function icsText(text: string): string {
		return text.replace(/\\/g, '\\\\').replace(/[,;]/g, '\\$&').replace(/\r?\n/g, '\\n');
	}

	function downloadIcs() {
		const start = new Date(walk.startsAt);
		const end = new Date(start.getTime() + WALK_HOURS * 3_600_000);
		const details = [
			walk.note,
			endSentence(`Look for: ${walk.lookFor}`),
			walk.phone ? `Text ${mentorFirstName} at ${walk.phone}.` : '',
		]
			.filter(Boolean)
			.join(' ');
		const lines = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:-//mentor-walks//EN',
			'BEGIN:VEVENT',
			`UID:mentor-walk-${walk.id}@${location.host}`,
			`DTSTAMP:${icsTime(new Date())}`,
			`DTSTART:${icsTime(start)}`,
			`DTEND:${icsTime(end)}`,
			`SUMMARY:${icsText(`Canvass with ${walk.mentorName}`)}`,
			`LOCATION:${icsText(walk.place)}`,
			`DESCRIPTION:${icsText(details)}`,
			'END:VEVENT',
			'END:VCALENDAR',
		];
		const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = 'mentor-walk.ics';
		a.click();
		URL.revokeObjectURL(url);
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
				<button type="button" class="mw-btn mw-btn-ghost" onclick={downloadIcs}>
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

<style>
	.mw-card {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-surface);
		scroll-margin-top: var(--space-6);
	}

	.mw-card-joined {
		border-color: var(--color-success);
		border-width: 2px;
	}

	.mw-card-selectable {
		cursor: pointer;
	}

	/* An outline, so it shows alongside a joined card's green border. */
	.mw-card-selected {
		outline: 3px solid var(--color-border-focus);
		outline-offset: 2px;
	}

	.mw-card p {
		margin: 0;
		line-height: 1.45;
	}

	.mw-card-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.mw-card h3 {
		margin: 0;
		font-size: var(--font-size-md);
	}

	.mw-look-for {
		font-size: var(--font-size-sm);
	}

	.mw-card .mw-actions {
		margin-top: var(--space-2);
	}
</style>

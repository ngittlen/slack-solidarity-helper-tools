<script lang="ts">
	// "Who showed up?": asked of the mentor once a walk's start time has passed
	// (specs/015-mentor-walks, User Story 6, FR-030/FR-031). Ticking someone
	// ends their "new" status; it never adds doors to anyone's count.

	import './mentor-walks.css';
	import type { MentorCheckinView } from '$lib/mentor-walks/types.js';

	interface Props {
		walk: MentorCheckinView;
		/** The ticked seats. Resolves true once saved. */
		onsave: (seatIds: string[]) => Promise<boolean>;
	}

	let { walk, onsave }: Props = $props();

	// svelte-ignore state_referenced_locally
	let ticked = $state<string[]>(walk.seats.filter((s) => s.ticked).map((s) => s.id));
	let busy = $state(false);

	async function save() {
		busy = true;
		try {
			await onsave(ticked);
		} finally {
			busy = false;
		}
	}
</script>

<section class="mw-panel mw-prompt" aria-labelledby="mw-checkin-heading-{walk.walkId}">
	<h2 id="mw-checkin-heading-{walk.walkId}">Who showed up?</h2>
	<p class="mw-muted">Your walk {walk.dayLabel.toLowerCase()} at {walk.timeLabel}, {walk.place}</p>

	<fieldset class="mw-checkin">
		<legend class="mw-muted">Tick everyone who came along</legend>
		{#each walk.seats as seat (seat.id)}
			<label>
				<input type="checkbox" value={seat.id} bind:group={ticked} />
				{seat.name}
			</label>
		{/each}
	</fieldset>
	<div class="mw-actions">
		<button type="button" class="mw-btn mw-btn-primary" disabled={busy} onclick={save}>
			{busy ? 'Saving…' : 'Save'}
		</button>
	</div>
</section>

<style>
	.mw-checkin {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		border: none;
	}

	.mw-checkin label {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 36px;
	}
</style>

<script lang="ts">
	// Asked of everyone who held a seat once the walk's start time has passed
	// (specs/015-mentor-walks, User Story 6, FR-030–FR-032).
	//
	// "I went" ends their "new" status (no doors credited). "Mentor didn't
	// show" posts to the Turf sync channel for organizers.

	import './mentor-walks.css';
	import type { WalkCheckinView } from '$lib/mentor-walks/types.js';

	type Answer = 'went' | 'no-show' | 'missed';

	interface Props {
		walk: WalkCheckinView;
		/** Resolves true once the answer is saved. */
		onanswer: (answer: Answer) => Promise<boolean>;
	}

	let { walk, onanswer }: Props = $props();

	// svelte-ignore state_referenced_locally
	let answer = $state<Answer | null>(walk.answer);
	let changing = $state(false);
	let busy = $state(false);

	const mentorFirstName = $derived(walk.mentorName.split(' ')[0]);

	async function choose(choice: Answer) {
		busy = true;
		try {
			if (await onanswer(choice)) {
				answer = choice;
				changing = false;
			}
		} finally {
			busy = false;
		}
	}
</script>

<section class="mw-panel mw-prompt" aria-labelledby="mw-after-heading-{walk.walkId}">
	<h2 id="mw-after-heading-{walk.walkId}">How did your walk with {walk.mentorName} go?</h2>
	<p class="mw-muted">{walk.dayLabel} at {walk.timeLabel}, {walk.place}</p>

	{#if answer === null || changing}
		<div class="mw-actions">
			<button
				type="button"
				class="mw-btn mw-btn-primary"
				disabled={busy}
				onclick={() => choose('went')}
			>
				I went
			</button>
			<button
				type="button"
				class="mw-btn mw-btn-ghost"
				disabled={busy}
				onclick={() => choose('no-show')}
			>
				{mentorFirstName} didn't show
			</button>
			<button
				type="button"
				class="mw-btn mw-btn-link"
				disabled={busy}
				onclick={() => choose('missed')}
			>
				I couldn't make it
			</button>
		</div>
	{:else}
		<p role="status">
			{#if answer === 'went'}
				🎉 Nice work! When you're ready, check out a turf of your own below. Your doors count from
				your own turf.
			{:else if answer === 'no-show'}
				Sorry about that. We've let the organizers know. There may be another walk near you below.
			{:else}
				No problem. There may be another walk near you below.
			{/if}
		</p>
		<div class="mw-actions">
			<button type="button" class="mw-btn mw-btn-link" onclick={() => (changing = true)}>
				Change my answer
			</button>
		</div>
	{/if}
</section>

<script lang="ts">
	// An active mentor's corner of /turfs: Host a walk, their upcoming walks
	// with who has joined, and their running totals (specs/015-mentor-walks,
	// User Story 2 and FR-033).

	import './mentor-walks.css';
	import type { MyWalkItem } from '$lib/mentor-walks/types.js';

	interface Props {
		walks: MyWalkItem[];
		walksHosted: number;
		newPeopleTakenOut: number;
		onhost: () => void;
		onedit: (id: string) => void;
		oncancel: (id: string) => void;
	}

	let { walks, walksHosted, newPeopleTakenOut, onhost, onedit, oncancel }: Props = $props();

	/** Cancel asks once before it notifies everyone who joined. */
	let confirmingCancel = $state<string | null>(null);
</script>

<section class="mw-panel" aria-labelledby="mw-mine-heading">
	<div class="mw-mine-top">
		<h2 id="mw-mine-heading">Your mentor walks</h2>
		<button type="button" class="mw-btn mw-btn-primary" onclick={onhost}>Host a walk</button>
	</div>
	<p class="mw-muted">
		You've hosted {walksHosted}
		{walksHosted === 1 ? 'walk' : 'walks'} and taken {newPeopleTakenOut} new
		{newPeopleTakenOut === 1 ? 'person' : 'people'} out. Thank you!
	</p>

	{#if walks.length === 0}
		<p>
			No upcoming walks. When you next plan to canvass, post it here so new people can join you.
		</p>
	{:else}
		<ul class="mw-list">
			{#each walks as walk (walk.id)}
				<li class="mw-mine-walk">
					<div>
						<strong>{walk.dayLabel} at {walk.timeLabel}</strong>
						<span class="mw-chip">{walk.joined.length} of {walk.seats} seats taken</span>
					</div>
					<p>{walk.place}</p>
					{#if walk.joined.length > 0}
						<p class="mw-muted">Joining: {walk.joined.join(', ')}</p>
					{/if}
					{#if confirmingCancel === walk.id}
						<p role="alert">
							Cancel this walk?
							{#if walk.joined.length > 0}
								{walk.joined.length === 1 ? 'The person' : `All ${walk.joined.length} people`} who joined
								will be told.
							{/if}
						</p>
						<div class="mw-actions">
							<button
								type="button"
								class="mw-btn mw-btn-danger"
								onclick={() => {
									confirmingCancel = null;
									oncancel(walk.id);
								}}
							>
								Yes, cancel it
							</button>
							<button
								type="button"
								class="mw-btn mw-btn-ghost"
								onclick={() => (confirmingCancel = null)}
							>
								Keep it
							</button>
						</div>
					{:else}
						<div class="mw-actions">
							<button type="button" class="mw-btn mw-btn-ghost" onclick={() => onedit(walk.id)}>
								Edit
							</button>
							<button
								type="button"
								class="mw-btn mw-btn-ghost"
								onclick={() => (confirmingCancel = walk.id)}
							>
								Cancel walk
							</button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.mw-mine-top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.mw-mine-walk {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-3);
		border: 1px solid var(--color-border-subtle);
		border-radius: var(--radius-sm);
	}

	.mw-mine-walk > div:first-child {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}
</style>

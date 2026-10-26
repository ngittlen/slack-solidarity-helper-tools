<script lang="ts">
	// Organizer view of mentors (specs/015-mentor-walks, User Story 4, FR-006):
	// make anyone a mentor, revoke, and reinstate.

	import Select from '$lib/components/ui/Select.svelte';
	import './mentor-walks.css';
	import type { OrganizerMentorView, PersonOption } from '$lib/mentor-walks/types.js';

	interface Props {
		mentors: OrganizerMentorView[];
		/** People who could be appointed: anyone not blocked and not already a
		 *  mentor. */
		candidates: PersonOption[];
		onappoint: (id: string) => void;
		onrevoke: (id: string) => void;
		onreinstate: (id: string) => void;
	}

	let { mentors, candidates, onappoint, onrevoke, onreinstate }: Props = $props();

	let pick = $state('');
	let confirmingRevoke = $state<string | null>(null);
</script>

<section class="mw-panel" aria-labelledby="mw-org-mentors-heading">
	<h2 id="mw-org-mentors-heading">Mentors</h2>

	<form
		class="mw-appoint"
		onsubmit={(event) => {
			event.preventDefault();
			if (!pick) return;
			onappoint(pick);
			pick = '';
		}}
	>
		<div class="mw-field">
			<label for="mw-appoint">Make someone a mentor</label>
			<Select
				id="mw-appoint"
				items={candidates.map((person) => ({ value: person.id, label: person.name }))}
				bind:value={pick}
				placeholder="Choose a volunteer…"
			/>
		</div>
		<button type="submit" class="mw-btn mw-btn-primary" disabled={!pick}>Make mentor</button>
	</form>
	<p class="mw-muted">
		They don't need to meet the 4-turf / 100-door bar. They'll agree to the guidelines before their
		first walk.
	</p>

	{#if mentors.length === 0}
		<p class="mw-muted">No mentors yet.</p>
	{/if}
	<ul class="mw-list">
		{#each mentors as mentor (mentor.id)}
			<li class="mw-mentor">
				<div class="mw-mentor-main">
					<strong>{mentor.name}</strong>
					{#if mentor.chapterName}
						<span class="mw-muted">{mentor.chapterName}</span>
					{/if}
					<span class="mw-muted">
						{mentor.walksHosted} walks · {mentor.newPeopleTakenOut} new people ·
						{mentor.agreedLabel ? `agreed to guidelines ${mentor.agreedLabel}` : 'not agreed yet'}
						{mentor.detail
							? ` · ${mentor.detail}`
							: mentor.source === 'organizer'
								? ' · appointed by an organizer'
								: ''}
					</span>
				</div>
				{#if mentor.status === 'revoked'}
					<div class="mw-actions">
						<span class="mw-chip mw-chip-error">Revoked</span>
						<button
							type="button"
							class="mw-btn mw-btn-ghost"
							onclick={() => onreinstate(mentor.id)}
						>
							Reinstate
						</button>
					</div>
				{:else if confirmingRevoke === mentor.id}
					<div class="mw-revoke-confirm">
						<p role="alert">
							Revoke {mentor.name}? Their upcoming walks are cancelled and everyone who joined is
							told.
						</p>
						<div class="mw-actions">
							<button
								type="button"
								class="mw-btn mw-btn-danger"
								onclick={() => {
									confirmingRevoke = null;
									onrevoke(mentor.id);
								}}
							>
								Revoke
							</button>
							<button
								type="button"
								class="mw-btn mw-btn-ghost"
								onclick={() => (confirmingRevoke = null)}
							>
								Keep
							</button>
						</div>
					</div>
				{:else}
					<button
						type="button"
						class="mw-btn mw-btn-ghost"
						onclick={() => (confirmingRevoke = mentor.id)}
					>
						Revoke
					</button>
				{/if}
			</li>
		{/each}
	</ul>
</section>

<style>
	.mw-appoint {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-2);
	}

	.mw-appoint .mw-field {
		flex: 1 1 14rem;
	}

	.mw-mentor {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.mw-mentor-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.mw-revoke-confirm {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		flex-basis: 100%;
	}
</style>

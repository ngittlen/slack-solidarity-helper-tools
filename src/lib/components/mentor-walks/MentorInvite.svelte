<script lang="ts">
	// The invitation an eligible canvasser sees on /turfs, and the guidelines
	// agreement every mentor passes before hosting (specs/015-mentor-walks,
	// User Story 1, FR-004/FR-005).
	//
	// `agreeOnly` skips the question for someone who is already a mentor but
	// has not agreed to the current guidelines: an organizer appointed them,
	// or the guidelines link changed since they agreed.

	import './mentor-walks.css';

	interface Props {
		guidelinesUrl: string;
		agreeOnly?: boolean;
		onagree: () => void;
		onsnooze?: () => void;
		ondecline?: () => void;
		/** Leaves the agreement without agreeing (agree-only mode). */
		oncancel?: () => void;
	}

	let {
		guidelinesUrl,
		agreeOnly = false,
		onagree,
		onsnooze,
		ondecline,
		oncancel,
	}: Props = $props();

	let accepted = $state(false);
	let agreed = $state(false);
	const step = $derived(agreeOnly || accepted ? 'agree' : 'ask');
</script>

<section class="mw-panel mw-prompt" aria-labelledby="mw-invite-heading">
	{#if step === 'ask'}
		<h2 id="mw-invite-heading">Help a new canvasser get started?</h2>
		<p>
			You've done a lot of canvassing. Lots of new volunteers would knock doors if they had someone
			to go out with the first time.
		</p>
		<p>
			As a mentor, you pick a time and a public place for your next canvass and how many new people
			can join you. No fixed schedule, no back-and-forth.
		</p>
		<div class="mw-actions">
			<button type="button" class="mw-btn mw-btn-primary" onclick={() => (accepted = true)}>
				Yes, I'm in
			</button>
			<button type="button" class="mw-btn mw-btn-ghost" onclick={onsnooze}>Not now</button>
			<button type="button" class="mw-btn mw-btn-link" onclick={ondecline}>No thanks</button>
		</div>
	{:else}
		<h2 id="mw-invite-heading">Before you host a walk</h2>
		<p>
			Mentors agree to the volunteer guidelines, which cover how we treat voters and each other.
		</p>
		<p>
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an external page -->
			<a href={guidelinesUrl} target="_blank" rel="noopener noreferrer">
				Read the volunteer guidelines
			</a>
		</p>
		<label class="mw-agree">
			<input type="checkbox" bind:checked={agreed} />
			I've read and agree to the volunteer guidelines
		</label>
		<div class="mw-actions">
			<button type="button" class="mw-btn mw-btn-primary" disabled={!agreed} onclick={onagree}>
				Continue
			</button>
			{#if agreeOnly}
				<button type="button" class="mw-btn mw-btn-ghost" onclick={oncancel}>Not now</button>
			{:else}
				<button type="button" class="mw-btn mw-btn-ghost" onclick={() => (accepted = false)}>
					Back
				</button>
			{/if}
		</div>
	{/if}
</section>

<style>
	.mw-agree {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		font-weight: 600;
	}

	.mw-agree input {
		margin-top: 0.3em;
	}
</style>

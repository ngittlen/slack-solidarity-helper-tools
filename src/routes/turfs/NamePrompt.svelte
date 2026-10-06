<script lang="ts">
	// Asks a Google or Apple volunteer for the name organizers will see, when
	// their provider sent none (specs/014-apple-sso-login, FR-011). Apple sends
	// a name only on the first sign-in, and a Google profile may have none.
	//
	// Two steps, because the app never lets anyone change it once saved (FR-011b;
	// a later Google profile name can still replace it, per FR-011a): the
	// server tidies what was typed and shows it back, and only the second
	// submit, with `confirm=1`, saves it. Plain forms, so it works without
	// JavaScript; `enhance` just keeps the map from reloading around it.

	import { enhance } from '$app/forms';

	interface Props {
		/** `?/setName`, carrying the page's own query so a no-JS reload lands
		 *  back on the same chapter. */
		action: string;
		/** The tidied name to confirm, from the first submit. */
		confirmName: string | null;
		error: string | null;
	}

	let { action, confirmName, error }: Props = $props();

	/** Set by "Edit" to go back from the confirmation to the box. */
	let editing = $state(false);
	const confirming = $derived(confirmName !== null && !editing);
</script>

<section class="name-prompt" aria-labelledby="name-prompt-heading">
	<h2 id="name-prompt-heading">What should organizers call you?</h2>

	{#if confirming}
		<p>
			Organizers will see you as <strong>{confirmName}</strong> in their turf log and on the turf you
			claim. You won't be able to change it here later.
		</p>
		<div class="name-prompt-actions">
			<form method="POST" {action} use:enhance>
				<input type="hidden" name="name" value={confirmName} />
				<input type="hidden" name="confirm" value="1" />
				<button type="submit" class="name-prompt-save">Save my name</button>
			</form>
			<button type="button" class="name-prompt-edit" onclick={() => (editing = true)}>Edit</button>
		</div>
	{:else}
		<p>
			We didn't get a name when you signed in. Choose one before you check out turf. It's how
			organizers will know who's walking each turf you claim.
		</p>
		<form
			method="POST"
			{action}
			class="name-prompt-form"
			use:enhance={() =>
				async ({ update }) => {
					await update({ reset: false });
					editing = false;
				}}
		>
			<label for="name-prompt-input">Your name</label>
			<input
				id="name-prompt-input"
				name="name"
				type="text"
				autocomplete="name"
				maxlength="64"
				required
				value={confirmName ?? ''}
			/>
			<button type="submit">Continue</button>
		</form>
	{/if}

	{#if error}
		<p class="name-prompt-error" role="alert">{error}</p>
	{/if}
</section>

<style>
	.name-prompt {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		max-width: 640px;
		margin: var(--space-3) auto 0;
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-warning);
		border-radius: var(--radius-md);
		background: var(--color-bg-surface);
	}

	.name-prompt h2 {
		margin: 0;
		font-size: var(--font-size-md);
	}

	.name-prompt p {
		margin: 0;
	}

	.name-prompt-form {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.name-prompt-form input {
		flex: 1 1 12rem;
		min-width: 0;
		font: inherit;
	}

	.name-prompt-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.name-prompt-error {
		color: var(--color-error);
	}
</style>

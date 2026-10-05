<script lang="ts">
	// The stored records of who has signed in with Google, and the one thing an
	// admin does with them: clear the lot at the end of a campaign (FR-020a of
	// specs/013-google-sso-login). Blocks and past claims survive the clear —
	// the description says so, because "will this unblock people?" is the
	// question an organizer will have.

	import { invalidateAll } from '$app/navigation';
	import ConfirmButton from './ConfirmButton.svelte';

	interface Props {
		/** How many Google volunteers have a stored record. */
		count: number;
	}

	let { count }: Props = $props();

	let cleared = $state<number | null>(null);

	async function clear(): Promise<void> {
		const res = await fetch('/api/settings/google-volunteers', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'clear' }),
		});
		const parsed = (await res.json().catch(() => null)) as {
			error?: string;
			cleared?: number;
		} | null;
		if (!res.ok) throw new Error(parsed?.error ?? `Clear failed (HTTP ${res.status})`);
		cleared = parsed?.cleared ?? 0;
		// The block-list picker lists these people; reload so it stops.
		await invalidateAll();
	}
</script>

<div class="google-records">
	<p class="google-records-count">
		{count === 1 ? '1 volunteer has' : `${count} volunteers have`} signed in with Google.
	</p>
	<ConfirmButton
		label="Clear Google volunteer records"
		description={`Delete the stored name and email of all ${count} volunteers who signed in with Google. Do this at the end of a campaign. Blocks stay in place and past claims keep the holder's name, but organizers will no longer see their emails. Anyone who signs in again gets a new record.`}
		confirmLabel="Clear records"
		disabled={count === 0}
		onConfirm={clear}
	/>
	{#if cleared !== null}
		<p class="google-records-done" role="status">
			Cleared {cleared === 1 ? '1 record' : `${cleared} records`}.
		</p>
	{/if}
</div>

<style>
	.google-records {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-2);
		margin-top: var(--space-3);
		max-width: 720px;
	}

	.google-records-count,
	.google-records-done {
		margin: 0;
	}

	.google-records-count {
		color: var(--color-text-muted);
	}
</style>

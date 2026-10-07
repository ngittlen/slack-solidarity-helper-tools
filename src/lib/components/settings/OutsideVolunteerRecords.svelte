<script lang="ts">
	// The stored records of who has signed in with Google or Apple, and the one
	// thing an admin does with them: clear the lot at the end of a campaign
	// (FR-020a of specs/013-google-sso-login, FR-020 of specs/014-apple-sso-login).
	// One count per provider and one button for both — no list of people, who
	// are found through the block-list picker instead. Blocks and past claims survive the clear —
	// the description says so, because "will this unblock people?" is the
	// question an organizer will have.

	import { invalidateAll } from '$app/navigation';
	import ConfirmButton from './ConfirmButton.svelte';

	interface Props {
		/** How many volunteers of each kind have a stored record. */
		counts: { google: number; apple: number };
	}

	let { counts }: Props = $props();

	const total = $derived(counts.google + counts.apple);

	let cleared = $state<number | null>(null);

	async function clear(): Promise<void> {
		const res = await fetch('/api/settings/outside-volunteers', {
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

<div class="outside-records">
	<p class="outside-records-count">
		Volunteers who signed in outside Slack: {counts.google} via Google, {counts.apple} via Apple.
	</p>
	<ConfirmButton
		label="Clear Google and Apple volunteer records"
		description={`Delete the stored name and email of all ${total} volunteers who signed in with Google or Apple. Do this at the end of a campaign. Blocks stay in place and past claims keep the holder's name, but organizers will no longer see their emails. Anyone who signs in again gets a new record, and Apple volunteers will be asked to type their name again, since Apple shares it only once.`}
		confirmLabel="Clear records"
		disabled={total === 0}
		onConfirm={clear}
	/>
	{#if cleared !== null}
		<p class="outside-records-done" role="status">
			Cleared {cleared === 1 ? '1 record' : `${cleared} records`}.
		</p>
	{/if}
</div>

<style>
	.outside-records {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-2);
		margin-top: var(--space-3);
		max-width: 720px;
	}

	.outside-records-count,
	.outside-records-done {
		margin: 0;
	}

	.outside-records-count {
		color: var(--color-text-muted);
	}
</style>

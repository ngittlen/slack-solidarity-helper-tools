<script lang="ts">
	// A turf holder's name as the admin views show it: a Slack or Google mark
	// in front, and for a Google sign-in their email after, so an organizer can
	// tell same-named volunteers apart and reach someone who is not in the
	// Slack. `account` only ever arrives on an admin's payload; without it this
	// is just the name.
	//
	// The marks are files under /static/icons rather than inline SVG: they are
	// brand artwork in fixed colours, which no theme token should touch.

	import { asset } from '$app/paths';
	import type { HolderAccount } from '$lib/holder-account.js';

	interface Props {
		name: string;
		account?: HolderAccount | null;
	}

	let { name, account = null }: Props = $props();

	const label = $derived(
		account?.provider === 'google' ? 'Signed in with Google' : 'Signed in with Slack',
	);
</script>

<span class="holder">
	{#if account}
		<img
			class="holder-mark"
			src={asset(account.provider === 'google' ? '/icons/google.svg' : '/icons/slack.svg')}
			alt={label}
			title={label}
			width="14"
			height="14"
		/>
	{/if}
	<span>{name}</span>
	{#if account?.email}
		<span class="holder-email">{account.email}</span>
	{/if}
</span>

<style>
	.holder {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 var(--space-1);
	}

	.holder-mark {
		flex: none;
		width: 14px;
		height: 14px;
	}

	.holder-email {
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
		overflow-wrap: anywhere;
	}
</style>

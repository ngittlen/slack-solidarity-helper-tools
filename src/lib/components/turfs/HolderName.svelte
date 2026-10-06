<script lang="ts">
	// A turf holder's name as the admin views show it: a Slack, Google or Apple
	// mark in front, and for a Google or Apple sign-in their email after, so an organizer can
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

	const MARKS = {
		slack: { label: 'Signed in with Slack', icon: '/icons/slack.svg' },
		google: { label: 'Signed in with Google', icon: '/icons/google.svg' },
		apple: { label: 'Signed in with Apple', icon: '/icons/apple.svg' },
	} as const;

	const mark = $derived(account ? MARKS[account.provider] : null);

	const RELAY_NOTE =
		"Apple Hide My Email relay address. Mail from your own account won't reach it.";
</script>

<span class="holder">
	{#if mark}
		<img
			class="holder-mark"
			src={asset(mark.icon)}
			alt={mark.label}
			title={mark.label}
			width="14"
			height="14"
		/>
	{/if}
	<span>{name}</span>
	{#if account?.email}
		<span class="holder-email">{account.email}</span>
		{#if account.isPrivateEmail}
			<!-- Apple's Hide My Email: unique to this app, so it still tells two
			     volunteers apart, but it only forwards mail from senders Apple
			     knows — an organizer writing from their own account bounces. -->
			<span class="holder-relay" title={RELAY_NOTE}>
				private relay<span class="visually-hidden">: {RELAY_NOTE}</span>
			</span>
		{/if}
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

	.holder-relay {
		padding: 0 var(--space-1);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		color: var(--color-text-muted);
		font-size: var(--font-size-xs);
		white-space: nowrap;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	.holder-email {
		color: var(--color-text-muted);
		font-size: var(--font-size-sm);
		overflow-wrap: anywhere;
	}
</style>

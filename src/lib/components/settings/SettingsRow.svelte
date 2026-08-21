<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	interface Props {
		label: string;
		/** Optional DOM id / URL fragment, from `sections.ts`. When set, the row
		 *  becomes an in-page anchor target for the settings sidebar: it also gets
		 *  `data-settings-anchor` (the CSS hook for scroll-margin) and
		 *  `tabindex="-1"`, so SvelteKit can move keyboard focus here after a
		 *  fragment jump. Rows without an id are unaffected. */
		id?: string;
		status?: AutosaveStatus;
		error?: string | null;
		onRetry?: () => void;
		children: Snippet;
	}

	let { label, id, status = 'idle', error = null, onRetry, children }: Props = $props();

	// Plain-text status labels so screen readers announce save state via the
	// aria-live region without needing icon-only fallbacks. The visible UI is
	// just text; an editor that wants icons can swap them in later.
	const statusLabel = $derived.by(() => {
		switch (status) {
			case 'pending':
				return '…';
			case 'saving':
				return 'Saving…';
			case 'saved':
				return 'Saved';
			case 'error':
				return 'Error';
			case 'idle':
			default:
				return '';
		}
	});
</script>

<!-- tabindex is always -1 or absent, which is exactly the case the a11y rule
	allows; it just can't see that through a ternary and widens the value to
	`number | undefined`. (svelte-ignore takes a bare code list, so the reason
	has to live in its own comment.) -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="settings-row"
	{id}
	data-settings-anchor={id}
	tabindex={id ? -1 : undefined}
	data-status={status}
>
	<div class="settings-row-header">
		<span class="settings-row-label">{label}</span>
		<span class="settings-row-status" aria-live="polite">{statusLabel}</span>
	</div>
	<div class="settings-row-control">
		{@render children()}
	</div>
	{#if status === 'error' && error}
		<p class="settings-row-error" role="alert">{error}</p>
	{/if}
	{#if status === 'error' && onRetry}
		<button
			type="button"
			class="settings-row-retry"
			onclick={onRetry}
			aria-label="Retry saving {label}"
		>
			Retry
		</button>
	{/if}
</div>

<style>
	.settings-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px 0;
	}

	/* Anchored rows take programmatic focus after a #fragment jump so keyboard
	 * and screen-reader users land in the section rather than back at the top of
	 * the page. No visible ring — this is a scroll target, not a control. */
	.settings-row[tabindex]:focus {
		outline: none;
	}

	.settings-row-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.settings-row-label {
		font-weight: 600;
		color: var(--color-text);
	}

	.settings-row-status {
		font-size: 0.85em;
		color: var(--color-text-muted);
		min-width: 60px;
		text-align: right;
	}

	.settings-row[data-status='saved'] .settings-row-status {
		color: var(--color-success);
	}

	.settings-row[data-status='error'] .settings-row-status {
		color: var(--color-error);
	}

	.settings-row-control {
		display: block;
	}

	.settings-row-error {
		margin: 0;
		font-size: 0.9em;
		color: var(--color-error);
	}

	.settings-row-retry {
		align-self: flex-start;
		background: transparent;
		color: var(--color-error);
		border: 1px solid currentColor;
		border-radius: var(--radius-sm);
		padding: 2px 10px;
		font: inherit;
		font-size: 0.85em;
		cursor: pointer;
	}

	.settings-row-retry:hover {
		background: color-mix(in srgb, var(--color-error) 8%, transparent);
	}
</style>

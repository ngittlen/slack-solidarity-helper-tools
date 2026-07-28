<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	interface Props {
		label: string;
		status?: AutosaveStatus;
		error?: string | null;
		onRetry?: () => void;
		children: Snippet;
	}

	let { label, status = 'idle', error = null, onRetry, children }: Props = $props();

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

<div class="settings-row" data-status={status}>
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

	.settings-row-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.settings-row-label {
		font-weight: 600;
		color: var(--color-text, inherit);
	}

	.settings-row-status {
		font-size: 0.85em;
		color: var(--color-text-muted, #888);
		min-width: 60px;
		text-align: right;
	}

	.settings-row[data-status='saved'] .settings-row-status {
		color: var(--color-success, #2e7d32);
	}

	.settings-row[data-status='error'] .settings-row-status {
		color: var(--color-error, #c62828);
	}

	.settings-row-control {
		display: block;
	}

	.settings-row-error {
		margin: 0;
		font-size: 0.9em;
		color: var(--color-error, #c62828);
	}

	.settings-row-retry {
		align-self: flex-start;
		background: transparent;
		color: var(--color-error, #c62828);
		border: 1px solid currentColor;
		border-radius: var(--radius-sm, 4px);
		padding: 2px 10px;
		font: inherit;
		font-size: 0.85em;
		cursor: pointer;
	}

	.settings-row-retry:hover {
		background: rgba(198, 40, 40, 0.08);
	}
</style>

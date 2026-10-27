<script lang="ts">
	// The search box above a long table: narrows it to rows matching the text
	// (see row-filter.ts), across every row the page holds, including the ones
	// not rendered yet. While it filters, it says how many rows match.

	interface Props {
		value?: string;
		/** What the box searches, for screen readers — "Filter turf out right now". */
		label: string;
		placeholder?: string;
		/** Rows matching the filter, and rows in all. */
		matched: number;
		total: number;
	}

	let { value = $bindable(''), label, placeholder = 'Filter', matched, total }: Props = $props();
</script>

<div class="table-filter">
	<input type="search" bind:value aria-label={label} {placeholder} autocomplete="off" />
	{#if value.trim()}
		<span class="count" role="status">
			{matched === 0
				? 'No rows match'
				: `${matched.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`}
		</span>
	{/if}
</div>

<style>
	.table-filter {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}

	input {
		flex: 0 1 320px;
		min-width: 0;
	}

	.count {
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}
</style>

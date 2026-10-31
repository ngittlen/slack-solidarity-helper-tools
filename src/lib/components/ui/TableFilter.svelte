<script lang="ts">
	// The search box above a long table: narrows it to rows matching the text
	// (see row-filter.ts), across every row the page holds, including the ones
	// not rendered yet. While it filters, it says how many rows match.
	//
	// What is typed goes to `value` once typing pauses for FILTER_DELAY_MS, or
	// at once on Enter or when the box is emptied — so the table is not
	// re-filtered between keystrokes. Not on leaving the box: the click that
	// leaves it may be on a row, and re-filtering on mousedown would move the
	// rows before the click lands.

	import { onMount } from 'svelte';
	import { FILTER_DELAY_MS } from '$lib/row-filter.js';
	import { debounced } from '$lib/debounce.js';

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

	/** What the box shows: what was typed, or `value` once the page sets it. */
	let draft = $derived(value);

	const applySoon = debounced((text: string) => {
		value = text;
	}, FILTER_DELAY_MS);

	function typed(event: Event & { currentTarget: HTMLInputElement }) {
		const text = event.currentTarget.value;
		// Emptied, by backspace or the clear button: nothing left to type. Not
		// whitespace, which is the start of typing more.
		if (text === '') applySoon.now(text);
		else applySoon.call(text);
	}

	function keyed(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
		// Not the Enter that confirms a word in an input method (Japanese,
		// Chinese): the text is not finished yet.
		if (event.key === 'Enter' && !event.isComposing) applySoon.now(event.currentTarget.value);
	}

	// Text typed before the page's script ran is picked up by the binding, but
	// typed no keys since — apply it, or the box and the table disagree.
	onMount(() => {
		if (draft !== value) applySoon.now(draft);
	});

	$effect(() => applySoon.cancel);
</script>

<div class="table-filter">
	<input
		type="search"
		bind:value={draft}
		oninput={typed}
		onkeydown={keyed}
		aria-label={label}
		{placeholder}
		autocomplete="off"
	/>
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

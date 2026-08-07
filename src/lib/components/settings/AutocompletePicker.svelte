<script lang="ts" generics="TId extends string | number">
	import { Combobox } from 'bits-ui';
	import type { PickerItem } from './picker-types.js';
	import { filterPickerItems, reconcileBlurInput } from './picker-logic.js';

	interface Props {
		items: PickerItem<TId>[];
		value: TId | null;
		onSelect: (id: TId) => void;
		placeholder?: string;
		disabled?: boolean;
		showSublabel?: boolean;
		/**
		 * Opt into server-side search. When supplied, typing calls this
		 * (debounced) and `items` is treated as already-filtered — the local
		 * substring filter is skipped entirely.
		 *
		 * This exists for lists too large to ship to the browser, where filtering
		 * a fixed array client-side isn't just slow but *wrong*: it would narrow
		 * against whatever page the server last returned rather than the real
		 * list, silently hiding matches that didn't make that page.
		 *
		 * Callers with a complete `items` array should omit it and keep the local
		 * filter, which needs no round trip.
		 */
		onSearch?: (query: string) => void;
		/** Debounce for `onSearch`, in ms. */
		searchDebounceMs?: number;
		/** Replaces the "No matches" empty state — lets a searching parent say
		 *  "Type at least 2 characters" or "Searching…" instead. */
		emptyMessage?: string;
	}

	let {
		items,
		value,
		onSelect,
		placeholder = '',
		disabled = false,
		showSublabel = false,
		onSearch,
		searchDebounceMs = 250,
		emptyMessage = 'No matches',
	}: Props = $props();

	let inputEl: HTMLInputElement | null = $state(null);

	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	// Clear a pending search if the picker goes away mid-keystroke.
	$effect(() => () => {
		if (searchTimer) clearTimeout(searchTimer);
	});

	function queueSearch(query: string): void {
		if (!onSearch) return;
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => onSearch(query.trim()), searchDebounceMs);
	}

	const selectedItem = $derived(items.find((i) => i.id === value) ?? null);

	// Writable $derived: defaults to the current selection's label, but
	// writes from oninput/blur override that default until the parent-driven
	// `value` (and thus selectedItem) changes again. This is the canonical
	// Svelte 5 replacement for the $state + $effect-sync pattern.
	let inputText = $derived(selectedItem?.label ?? '');

	const filteredItems = $derived.by(() => {
		// Server-search mode: `items` is the answer to the current query, so
		// re-filtering it locally could only remove correct results.
		if (onSearch) return items;
		const q = inputText.trim().toLowerCase();
		const selectedLabel = (selectedItem?.label ?? '').toLowerCase();
		// Empty query OR query equals the current selection's label →
		// show the full list. Lets the user open the dropdown without
		// the filter immediately collapsing to one item.
		if (q === '' || q === selectedLabel) return items;
		// Delegate the actual filter to the pure helper (T024) so the
		// substring behavior is unit-testable without JSDOM.
		return filterPickerItems(items, inputText);
	});

	function handleValueChange(rawId: string): void {
		// Bits UI hands us a stringified id. Lookup against the items list
		// guarantees no free-text fallthrough (FR-012): if `rawId` isn't an
		// item's id (coerced to string), nothing fires.
		const item = items.find((i) => String(i.id) === rawId);
		if (!item) return;
		onSelect(item.id);
		inputText = item.label;
	}

	function handleBlur(): void {
		// Delegate the accept/reject decision to the pure helper so the
		// guarantee is testable. The DOM-revert side effect stays here.
		const decision = reconcileBlurInput(items, inputText);
		if (decision.accept) {
			if (decision.id !== value) onSelect(decision.id);
			const match = items.find((i) => i.id === decision.id);
			inputText = match?.label ?? '';
		} else {
			// Revert. The visible input value lags behind because Bits UI's
			// Combobox.Input doesn't accept a controlled `value` — we have to
			// rewrite the DOM node directly so the user sees the revert.
			inputText = selectedItem?.label ?? '';
			if (inputEl) inputEl.value = inputText;
		}
	}
</script>

<Combobox.Root
	type="single"
	value={value === null ? '' : String(value)}
	onValueChange={handleValueChange}
	{disabled}
>
	<div class="picker-row">
		<Combobox.Input
			defaultValue={selectedItem?.label ?? ''}
			oninput={(e) => {
				inputText = (e.currentTarget as HTMLInputElement).value;
				queueSearch(inputText);
			}}
			onblur={handleBlur}
			{placeholder}
			class="picker-input"
			bind:ref={inputEl}
		/>
		<Combobox.Trigger class="picker-trigger" aria-label="Open dropdown">▾</Combobox.Trigger>
	</div>
	<Combobox.Portal>
		<Combobox.Content class="picker-content">
			{#if filteredItems.length === 0}
				<div class="picker-empty">{emptyMessage}</div>
			{:else}
				{#each filteredItems as item (item.id)}
					<Combobox.Item
						value={String(item.id)}
						label={item.label}
						data-selected={item.id === value ? 'true' : undefined}
						class="picker-item"
					>
						<span class="picker-item-label">{item.label}</span>
						{#if showSublabel && item.sublabel}
							<span class="picker-item-sublabel">{item.sublabel}</span>
						{/if}
					</Combobox.Item>
				{/each}
			{/if}
		</Combobox.Content>
	</Combobox.Portal>
</Combobox.Root>

<style>
	.picker-row {
		display: inline-flex;
		align-items: stretch;
		border: 1px solid var(--color-border, #ccc);
		border-radius: var(--radius-md, 6px);
		background: var(--color-bg-surface, #fff);
	}

	:global(.picker-input) {
		flex: 1;
		min-width: 200px;
		border: none;
		background: transparent;
		padding: 6px 10px;
		font: inherit;
		color: inherit;
		outline: none;
	}

	:global(.picker-trigger) {
		border: none;
		border-left: 1px solid var(--color-border, #ccc);
		background: transparent;
		padding: 0 10px;
		cursor: pointer;
		font: inherit;
		color: inherit;
	}

	:global(.picker-content) {
		background: var(--color-bg-surface, #fff);
		border: 1px solid var(--color-border, #ccc);
		border-radius: var(--radius-md, 6px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
		padding: 4px;
		max-height: 240px;
		overflow-y: auto;
		min-width: var(--bits-combobox-anchor-width, 220px);
		z-index: 50;
	}

	.picker-empty {
		padding: 8px 10px;
		color: var(--color-text-muted, #888);
		font-style: italic;
	}

	:global(.picker-item) {
		display: flex;
		flex-direction: column;
		padding: 6px 10px;
		border-radius: var(--radius-sm, 4px);
		cursor: pointer;
	}

	:global(.picker-item[data-highlighted]) {
		background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
	}

	:global(.picker-item[data-selected='true']) {
		font-weight: 600;
		color: var(--color-gold, #b8860b);
	}

	.picker-item-sublabel {
		font-size: 0.85em;
		color: var(--color-text-muted, #888);
	}
</style>

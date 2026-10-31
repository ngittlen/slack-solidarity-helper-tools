<script lang="ts" module>
	export interface SelectItem {
		value: string;
		label: string;
		disabled?: boolean;
	}
</script>

<script lang="ts">
	// The app's dropdown: a bits-ui Select, styled once for every page.
	//
	// Values are strings, as a form field's are. An item may have the value ''
	// ("All chapters", "None"), which bits-ui treats as no selection, so it is
	// swapped for a sentinel inside the Select and swapped back on the way out.
	// For the same reason the form field is this component's own hidden input
	// rather than bits-ui's: it submits the real value, '' included.
	//
	// `value` has no fallback, and undefined reads as '': a binding to a record
	// entry not yet set passes undefined, which Svelte refuses for a prop with a
	// fallback.

	import { tick } from 'svelte';
	import { Select } from 'bits-ui';

	interface Props {
		items: readonly SelectItem[];
		value?: string;
		onValueChange?: (value: string) => void;
		/** Submitted with the enclosing form under this name. */
		name?: string;
		/** For a `<label for>`. */
		id?: string;
		'aria-label'?: string;
		disabled?: boolean;
		/** Shown when the value matches no item. */
		placeholder?: string;
		/** Submit the enclosing form once the value has changed — for GET
		 *  filter forms with no submit button. */
		submitOnChange?: boolean;
		size?: 'sm' | 'md';
		class?: string;
	}

	let {
		items,
		value = $bindable(),
		onValueChange,
		name,
		id,
		'aria-label': ariaLabel,
		disabled = false,
		placeholder = 'Choose…',
		submitOnChange = false,
		size = 'md',
		class: className = '',
	}: Props = $props();

	const EMPTY = '\u0000empty';
	const toInner = (v: string) => (v === '' ? EMPTY : v);
	const toOuter = (v: string) => (v === EMPTY ? '' : v);

	let trigger = $state<HTMLButtonElement | null>(null);

	/** Where the open list is drawn: inside the modal <dialog> the select sits
	 *  in, if any. A modal dialog is in the top layer and makes the rest of the
	 *  page inert, so a list drawn on <body> opens behind it, out of reach. */
	const portalTo = $derived(trigger?.closest('dialog') ?? 'body');

	const current = $derived(value ?? '');
	const selectedLabel = $derived(items.find((item) => item.value === current)?.label ?? null);

	async function change(next: string) {
		const outer = toOuter(next);
		if (outer === current) return;
		value = outer;
		onValueChange?.(outer);
		if (submitOnChange) {
			// The hidden input below takes the new value on the next render.
			await tick();
			trigger?.closest('form')?.requestSubmit();
		}
	}
</script>

{#if name}
	<input type="hidden" {name} value={current} />
{/if}
<Select.Root
	type="single"
	value={toInner(current)}
	onValueChange={change}
	{disabled}
	items={items.map((item) => ({ ...item, value: toInner(item.value) }))}
>
	<Select.Trigger
		bind:ref={trigger}
		{id}
		aria-label={ariaLabel}
		class="ui-select-trigger ui-select-{size} {className}"
		data-placeholder={selectedLabel === null ? '' : undefined}
	>
		<span class="ui-select-value">{selectedLabel ?? placeholder}</span>
		<svg
			class="ui-select-chevron"
			viewBox="0 0 16 16"
			width="12"
			height="12"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			fill="none"
			aria-hidden="true"
		>
			<path d="M4 6l4 4 4-4" />
		</svg>
	</Select.Trigger>
	<Select.Portal to={portalTo}>
		<Select.Content class="ui-select-content" sideOffset={4}>
			<Select.Viewport class="ui-select-viewport">
				{#each items as item (item.value)}
					<Select.Item
						value={toInner(item.value)}
						label={item.label}
						disabled={item.disabled}
						class="ui-select-item ui-select-{size}"
					>
						{#snippet children({ selected })}
							<span>{item.label}</span>
							{#if selected}
								<svg
									viewBox="0 0 16 16"
									width="12"
									height="12"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									fill="none"
									aria-hidden="true"
								>
									<path d="M3.5 8.5l3 3 6-7" />
								</svg>
							{/if}
						{/snippet}
					</Select.Item>
				{/each}
			</Select.Viewport>
		</Select.Content>
	</Select.Portal>
</Select.Root>

<style>
	:global(.ui-select-trigger) {
		display: inline-flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		min-width: 0;
		max-width: 100%;
		font: inherit;
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		cursor: pointer;
		text-align: left;
	}

	/* The same box as a text field (app.css), so a form mixing the two lines
	   up. */
	:global(.ui-select-trigger.ui-select-md) {
		padding: var(--space-2) var(--space-3);
		line-height: 1.4;
	}

	:global(.ui-select-trigger.ui-select-sm) {
		padding: 4px 10px;
		font-size: var(--font-size-sm);
	}

	:global(.ui-select-trigger:hover:not(:disabled)),
	:global(.ui-select-trigger[data-state='open']) {
		border-color: var(--color-text-muted);
	}

	:global(.ui-select-trigger:focus-visible) {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 1px;
	}

	:global(.ui-select-trigger:disabled) {
		opacity: 0.6;
		cursor: not-allowed;
	}

	:global(.ui-select-trigger[data-placeholder]) {
		color: var(--color-text-muted);
	}

	:global(.ui-select-value) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.ui-select-chevron) {
		flex: none;
		color: var(--color-text-muted);
		transition: transform 120ms ease;
	}

	:global(.ui-select-trigger[data-state='open'] .ui-select-chevron) {
		transform: rotate(180deg);
	}

	:global(.ui-select-content) {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-popover);
		padding: 4px;
		min-width: max(var(--bits-select-anchor-width, 0px), 160px);
		max-width: min(90vw, 420px);
		max-height: min(var(--bits-select-content-available-height, 320px), 320px);
		overflow-y: auto;
		z-index: 50;
	}

	:global(.ui-select-item) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: 6px 10px;
		color: var(--color-text);
		border-radius: var(--radius-sm);
		cursor: pointer;
		outline: none;
	}

	:global(.ui-select-item.ui-select-sm) {
		font-size: var(--font-size-sm);
	}

	:global(.ui-select-item[data-highlighted]) {
		background: var(--color-bg-hover);
	}

	:global(.ui-select-item[data-selected]) {
		font-weight: 600;
		color: var(--color-blue);
	}

	:global(.ui-select-item[data-disabled]) {
		color: var(--color-text-faint);
		cursor: not-allowed;
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.ui-select-chevron) {
			transition: none;
		}
	}
</style>

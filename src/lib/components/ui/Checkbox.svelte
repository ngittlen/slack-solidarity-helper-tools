<script lang="ts">
	// The app's checkbox: a bits-ui Checkbox, styled once for every page. Put it
	// inside a `<label>` with its text, or give it an `aria-label`.
	//
	// `checked` has no fallback, and undefined reads as unticked: a binding to
	// a record entry not yet set, such as `bind:checked={ticked[id]}`, passes
	// undefined, which Svelte refuses for a prop with a fallback.

	import { tick } from 'svelte';
	import { Checkbox } from 'bits-ui';

	interface Props {
		checked?: boolean;
		onCheckedChange?: (checked: boolean) => void;
		/** Submitted with the enclosing form under this name, while ticked. */
		name?: string;
		value?: string;
		id?: string;
		'aria-label'?: string;
		title?: string;
		disabled?: boolean;
		/** Submit the enclosing form once the box has changed. */
		submitOnChange?: boolean;
		class?: string;
	}

	let {
		checked = $bindable(),
		onCheckedChange,
		name,
		value,
		id,
		'aria-label': ariaLabel,
		title,
		disabled = false,
		submitOnChange = false,
		class: className = '',
	}: Props = $props();

	let box = $state<HTMLButtonElement | null>(null);

	async function change(next: boolean) {
		checked = next;
		onCheckedChange?.(next);
		if (submitOnChange) {
			await tick();
			box?.closest('form')?.requestSubmit();
		}
	}
</script>

<Checkbox.Root
	bind:ref={box}
	checked={checked ?? false}
	onCheckedChange={change}
	{name}
	{value}
	{id}
	{disabled}
	{title}
	aria-label={ariaLabel}
	class="ui-checkbox {className}"
>
	<!-- Drawn whether ticked or not, and only shown when ticked: an empty box
	     sits on a different baseline from one holding an icon, so adding the
	     icon on tick would move the box. -->
	<svg
		class="ui-checkbox-mark"
		viewBox="0 0 16 16"
		width="12"
		height="12"
		stroke="currentColor"
		stroke-width="2.25"
		stroke-linecap="round"
		stroke-linejoin="round"
		fill="none"
		aria-hidden="true"
	>
		<path d="M3.5 8.5l3 3 6-7" />
	</svg>
</Checkbox.Root>

<style>
	:global(.ui-checkbox) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 18px;
		height: 18px;
		padding: 0;
		color: var(--color-action-text);
		background: var(--color-surface);
		border: 1.5px solid var(--color-text-muted);
		border-radius: var(--radius-sm);
		cursor: pointer;
		vertical-align: middle;
		/* Centred on its label's line, wherever the label aligns its text. */
		align-self: center;
	}

	:global(.ui-checkbox-mark) {
		visibility: hidden;
	}

	:global(.ui-checkbox[data-state='checked'] .ui-checkbox-mark) {
		visibility: visible;
	}

	:global(.ui-checkbox[data-state='checked']) {
		background: var(--color-action);
		border-color: var(--color-action);
	}

	:global(.ui-checkbox:hover:not(:disabled)) {
		border-color: var(--color-action);
	}

	:global(.ui-checkbox:focus-visible) {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 2px;
	}

	:global(.ui-checkbox:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

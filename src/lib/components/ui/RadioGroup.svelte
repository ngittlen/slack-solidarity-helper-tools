<script lang="ts" module>
	export interface RadioItem {
		value: string;
		label: string;
		disabled?: boolean;
	}
</script>

<script lang="ts">
	// The app's radio buttons: a bits-ui RadioGroup, styled once for every page.

	import { RadioGroup } from 'bits-ui';

	interface Props {
		items: readonly RadioItem[];
		value?: string;
		onValueChange?: (value: string) => void;
		name?: string;
		/** The id of the element that names the group, such as a legend. */
		'aria-labelledby'?: string;
		'aria-label'?: string;
		disabled?: boolean;
		class?: string;
	}

	let {
		items,
		value = $bindable(),
		onValueChange,
		name,
		'aria-labelledby': labelledBy,
		'aria-label': ariaLabel,
		disabled = false,
		class: className = '',
	}: Props = $props();

	const uid = $props.id();
</script>

<RadioGroup.Root
	value={value ?? ''}
	onValueChange={(next) => {
		value = next;
		onValueChange?.(next);
	}}
	{name}
	{disabled}
	aria-labelledby={labelledBy}
	aria-label={ariaLabel}
	class="ui-radio-group {className}"
>
	{#each items as item (item.value)}
		<div class="ui-radio-option">
			<RadioGroup.Item
				id="{uid}-{item.value}"
				value={item.value}
				disabled={item.disabled}
				class="ui-radio"
			/>
			<label for="{uid}-{item.value}">{item.label}</label>
		</div>
	{/each}
</RadioGroup.Root>

<style>
	:global(.ui-radio-group) {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.ui-radio-option {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.ui-radio-option label {
		cursor: pointer;
	}

	:global(.ui-radio) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 18px;
		height: 18px;
		padding: 0;
		background: var(--color-surface);
		border: 1.5px solid var(--color-text-muted);
		border-radius: 50%;
		cursor: pointer;
	}

	:global(.ui-radio[data-state='checked']) {
		border-color: var(--color-action);
		background: radial-gradient(circle, var(--color-action) 0 4px, transparent 4.5px);
	}

	:global(.ui-radio:hover:not(:disabled)) {
		border-color: var(--color-action);
	}

	:global(.ui-radio:focus-visible) {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 2px;
	}

	:global(.ui-radio:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

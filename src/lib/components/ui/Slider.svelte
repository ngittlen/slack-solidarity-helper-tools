<script lang="ts">
	// The app's slider: a bits-ui Slider with one thumb, styled once for every
	// page. `onValueChange` fires as it is dragged.

	import { Slider } from 'bits-ui';

	interface Props {
		value?: number;
		onValueChange?: (value: number) => void;
		min: number;
		max: number;
		step?: number;
		/** Names the thumb, which is what a screen reader lands on. */
		'aria-label'?: string;
		disabled?: boolean;
		class?: string;
	}

	let {
		value = $bindable(),
		onValueChange,
		min,
		max,
		step = 1,
		'aria-label': ariaLabel,
		disabled = false,
		class: className = '',
	}: Props = $props();
</script>

<Slider.Root
	type="single"
	value={value ?? min}
	onValueChange={(next) => {
		value = next;
		onValueChange?.(next);
	}}
	{min}
	{max}
	{step}
	{disabled}
	class="ui-slider {className}"
>
	<span class="ui-slider-track">
		<Slider.Range class="ui-slider-range" />
	</span>
	<Slider.Thumb index={0} aria-label={ariaLabel} class="ui-slider-thumb" />
</Slider.Root>

<style>
	:global(.ui-slider) {
		position: relative;
		display: flex;
		align-items: center;
		width: 100%;
		height: 24px;
		touch-action: none;
		user-select: none;
	}

	.ui-slider-track {
		position: relative;
		flex: 1;
		height: 4px;
		overflow: hidden;
		background: var(--color-border);
		border-radius: 999px;
	}

	:global(.ui-slider-range) {
		position: absolute;
		height: 100%;
		background: var(--color-action);
	}

	:global(.ui-slider-thumb) {
		display: block;
		width: 18px;
		height: 18px;
		background: var(--color-surface);
		border: 2px solid var(--color-action);
		border-radius: 50%;
		box-shadow: var(--shadow-popover);
		cursor: grab;
	}

	:global(.ui-slider-thumb:active) {
		cursor: grabbing;
	}

	:global(.ui-slider-thumb:focus-visible) {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 2px;
	}

	:global(.ui-slider[data-disabled]) {
		opacity: 0.5;
	}
</style>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { DASHBOARD_DAYS_PRESETS, type DashboardDaysPreset } from './days.js';

	type Props = { current: DashboardDaysPreset };
	let { current }: Props = $props();

	function select(value: DashboardDaysPreset) {
		if (value === current) return;
		// Same-route navigation, just swapping the query string.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(`?days=${value}`, { keepFocus: true, noScroll: true });
	}
</script>

<div class="range-preset-picker" role="group" aria-label="Time range">
	{#each DASHBOARD_DAYS_PRESETS as value (value)}
		<button
			type="button"
			class="preset"
			class:active={value === current}
			aria-pressed={value === current}
			onclick={() => select(value)}
		>
			{value} days
		</button>
	{/each}
</div>

<style>
	.range-preset-picker {
		display: inline-flex;
		border: 1px solid #d0d5dd;
		border-radius: 8px;
		overflow: hidden;
		background: white;
	}
	.preset {
		appearance: none;
		background: transparent;
		border: 0;
		padding: 0.5rem 1rem;
		font: inherit;
		color: #1f2937;
		cursor: pointer;
		border-right: 1px solid #d0d5dd;
	}
	.preset:last-child {
		border-right: 0;
	}
	.preset.active {
		background: #1f2937;
		color: white;
	}
	.preset:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
		position: relative;
		z-index: 1;
	}
</style>

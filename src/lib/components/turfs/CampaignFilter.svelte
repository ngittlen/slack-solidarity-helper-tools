<script lang="ts">
	import Select from '$lib/components/ui/Select.svelte';

	interface Props {
		/** The campaigns to choose between, in the order shown. */
		options: { id: number; badge: string }[];
		/** The picked campaign, or null for all of them. */
		value: number | null;
		onchange: (value: number | null) => void;
	}

	const { options, value, onchange }: Props = $props();

	const items = $derived([
		{ value: '', label: 'All campaigns' },
		...options.map((option) => ({ value: String(option.id), label: option.badge })),
	]);
</script>

<Select
	{items}
	value={value === null ? '' : String(value)}
	onValueChange={(next) => onchange(next === '' ? null : Number(next))}
	aria-label="Campaign"
	class="campaign-trigger"
/>

<style>
	/* The same box as the sort buttons above it (.sort-btn). */
	:global(.ui-select-trigger.campaign-trigger) {
		padding: 7px 10px;
		font-size: var(--font-size-md);
		font-weight: 600;
	}

	:global(.ui-select-trigger.campaign-trigger:hover) {
		border-color: var(--color-action);
		background: var(--color-cream-light);
	}
</style>

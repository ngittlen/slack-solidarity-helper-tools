<script lang="ts">
	// The heading of a collapsible card list on /turfs (mentor walks, canvass
	// events): the heading itself is the button, with a turning arrow and a
	// count of what's inside. The section it heads takes `id` as its label,
	// and `controls` names an element that stays in the page while closed.

	import './mentor-walks.css';

	interface Props {
		/** The heading's id, for the section's aria-labelledby. */
		id: string;
		label: string;
		count: number;
		/** The id of the list it shows and hides. */
		controls: string;
		open: boolean;
	}

	let { id, label, count, controls, open = $bindable() }: Props = $props();
</script>

<h2 class="mw-section-heading" {id}>
	<button
		type="button"
		class="mw-section-toggle"
		aria-expanded={open}
		aria-controls={controls}
		onclick={() => (open = !open)}
	>
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
			<path d="M6 3l5 5-5 5" />
		</svg>
		{label}
		<span class="mw-chip">{count}</span>
	</button>
</h2>

<style>
	.mw-section-heading {
		margin: 0;
		font-size: var(--font-size-md);
	}

	/* The heading's own look, the whole row a target. */
	.mw-section-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 36px;
		padding: 0;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		font-weight: 700;
		text-align: left;
		cursor: pointer;
	}

	.mw-section-toggle:focus-visible {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}

	.mw-section-toggle svg {
		flex: none;
		transition: transform 120ms ease;
	}

	.mw-section-toggle[aria-expanded='true'] svg {
		transform: rotate(90deg);
	}

	@media (prefers-reduced-motion: reduce) {
		.mw-section-toggle svg {
			transition: none;
		}
	}
</style>

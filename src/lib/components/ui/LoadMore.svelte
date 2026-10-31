<script lang="ts">
	// Put after a long list: calls `onnear` as the reader scrolls within
	// NEAR_PX of the list's end, so the next rows are in place before they get
	// there. Inside a box that scrolls on its own, put it in the box, after the
	// list: it watches the nearest scrolling ancestor, or the page when there is
	// none. One call at a time; when a call finishes and the end is still
	// near — a short page, or a fast scroll — it calls again rather than
	// waiting for a scroll that may never come.
	//
	// The button is the way in without a scroll: hidden until focused, so a
	// keyboard or screen-reader user can reach it. When a press loads the last
	// page, the button goes with it, and focus moves to the first row it
	// added — so the reader carries on from there, not from the top.

	import { tick } from 'svelte';
	import type { Attachment } from 'svelte/attachments';

	interface Props {
		/** Show or fetch the next rows. */
		onnear: () => void | Promise<void>;
		/** Nothing more to show: renders nothing. */
		disabled?: boolean;
	}

	const { onnear, disabled = false }: Props = $props();

	/** How far ahead of the list's end to start. A few rows' height, so an
	 *  ordinary scroll does not outrun a fetch. */
	const NEAR_PX = 600;

	let busy = false;

	let sentinel = $state<HTMLElement>();
	let button = $state<HTMLButtonElement>();

	/** The rows on screen when the button took focus or was last pressed: the
	 *  ones a load did not add. */
	let seen: { container: Element; rows: Set<Element> } | null = null;

	function noteRows() {
		const container = sentinel?.parentElement;
		if (container) seen = { container, rows: new Set(container.querySelectorAll('tr, li')) };
	}

	/** Focus the first row not in `before`, or failing that the last row it
	 *  held. A row is not focusable by default, so it takes tabindex -1:
	 *  reachable by script, still out of the tab order. */
	function focusFirstNewRow(before: NonNullable<typeof seen>) {
		const rows = [...before.container.querySelectorAll('tr, li')];
		const row = rows.find((r) => !before.rows.has(r)) ?? rows.findLast((r) => before.rows.has(r));
		if (!(row instanceof HTMLElement)) return;
		row.tabIndex = -1;
		row.focus();
	}

	// Runs ahead of the {#if} below, so the button is still on the page.
	$effect.pre(() => {
		if (!disabled || !seen || !button || document.activeElement !== button) return;
		const before = seen;
		void tick().then(() => focusFirstNewRow(before));
	});

	/** The nearest ancestor that scrolls vertically, or null for the page. */
	function scrollRoot(el: Element): Element | null {
		for (let node = el.parentElement; node; node = node.parentElement) {
			const { overflowY } = getComputedStyle(node);
			if (overflowY === 'auto' || overflowY === 'scroll') return node;
		}
		return null;
	}

	function isNear(el: Element, root: Element | null): boolean {
		const bottom = root ? root.getBoundingClientRect().bottom : window.innerHeight;
		return el.getBoundingClientRect().top < bottom + NEAR_PX;
	}

	async function load(el: Element | null, root: Element | null = null) {
		if (busy) return;
		busy = true;
		try {
			await onnear();
		} finally {
			busy = false;
		}
		// Measured rather than read from the observer: it reports changes only,
		// and a sentinel that stayed in range through the load reports none.
		// Waits a frame so the new rows are laid out before measuring.
		if (!el) return;
		requestAnimationFrame(() => {
			if (el.isConnected && isNear(el, root)) void load(el, root);
		});
	}

	const watch: Attachment<HTMLElement> = (el) => {
		const root = scrollRoot(el);
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) void load(el, root);
			},
			{ root, rootMargin: `${NEAR_PX}px 0px` },
		);
		observer.observe(el);
		return () => observer.disconnect();
	};
</script>

{#if !disabled}
	<div class="sentinel" aria-hidden="true" bind:this={sentinel} {@attach watch}></div>
	<button
		type="button"
		class="more"
		bind:this={button}
		onfocus={noteRows}
		onclick={() => {
			noteRows();
			void load(null);
		}}
	>
		Show more
	</button>
{/if}

<style>
	.sentinel {
		height: 1px;
	}

	.more {
		display: block;
		margin: var(--space-3) auto;
		padding: var(--space-2) var(--space-4);
		font: inherit;
		font-size: var(--font-size-sm);
		color: var(--color-action);
		background: none;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		cursor: pointer;
	}

	/* Off screen, not display: none, so it stays in the tab order. In flow
	   rather than absolute: inside a scrolling table box, an absolute button
	   escapes the box and sits at the foot of the table's full height,
	   stretching the page with blank scroll room. */
	.more:not(:focus) {
		width: 1px;
		height: 1px;
		margin: -1px 0 0;
		padding: 0;
		border: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>

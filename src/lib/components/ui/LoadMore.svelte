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
	// keyboard reader can tab to it, and visible if the browser turns out to
	// have no IntersectionObserver. The server cannot know that, so it renders
	// the same markup as a browser that has one, and the attachment — which
	// only runs in the browser — finds out.

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

	let unobservable = $state(false);
	let busy = false;

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
		if (typeof IntersectionObserver === 'undefined') {
			unobservable = true;
			return;
		}
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
	<div class="sentinel" aria-hidden="true" {@attach watch}></div>
	<button type="button" class={['more', { hidden: !unobservable }]} onclick={() => load(null)}>
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

	/* Off screen, not display: none, so it stays in the tab order. */
	.more.hidden:not(:focus) {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>

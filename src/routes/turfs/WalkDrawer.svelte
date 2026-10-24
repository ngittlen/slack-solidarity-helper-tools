<script lang="ts">
	// The mentor walks drawer on /turfs (specs/015-mentor-walks): a sheet that
	// slides in from the left with walk messages, the mentor's own walks and
	// staff tools, so they don't sit above the turfs. The walk cards stay at
	// the top of the turf list, and alerts are the header bell's. The chapter
	// bar's "Mentor walks" button opens it.
	//
	// A native modal <dialog>, so focus stays inside, Esc closes it and the
	// page behind can't be clicked. Its contents stay mounted while it's shut,
	// so a half-filled walk form survives closing it.

	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		onclose: () => void;
		children: Snippet;
	}

	let { open, onclose, children }: Props = $props();

	let dialog: HTMLDialogElement;
	/** Where the last press started. A drag from the sheet that lets go over
	 *  the backdrop clicks the dialog too, and mustn't close it. */
	let pressedBackdrop = false;

	$effect(() => {
		if (open && !dialog.open) {
			dialog.showModal();
			// What the contents asked to have focused, like "Stop these alerts"
			// from an alert's link. Otherwise the browser picks the close button.
			dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});
</script>

<!-- A click on the backdrop lands on the dialog itself; the sheet inside
     covers the rest, and does its own scrolling so its scrollbar is the
     sheet's too. Esc is the keyboard's way out, so no key handler here. -->
<dialog
	bind:this={dialog}
	class="walk-drawer"
	aria-labelledby="walk-drawer-title"
	{onclose}
	onpointerdown={(e) => (pressedBackdrop = e.target === dialog)}
	onclick={(e) => {
		// A message's link, like a walk's card further down this page: shut,
		// or it would cover what the link goes to. Not for one opened in a
		// new tab.
		const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
		if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) dialog.close();
		else if (pressedBackdrop && e.target === dialog) dialog.close();
		pressedBackdrop = false;
	}}
>
	<div class="drawer-sheet">
		<header class="drawer-head">
			<h2 id="walk-drawer-title"><span aria-hidden="true">👟</span> Mentor walks</h2>
			<button type="button" class="drawer-close" onclick={() => dialog.close()}>
				<span aria-hidden="true">✕</span>
				<span class="drawer-close-label">Close</span>
			</button>
		</header>
		{@render children()}
	</div>
</dialog>

<style>
	.walk-drawer {
		/* Pinned to the left edge, full height, instead of centred. */
		position: fixed;
		inset: 0 auto 0 0;
		width: min(480px, 100vw);
		max-width: 100vw;
		height: 100dvh;
		max-height: 100dvh;
		overflow: hidden;
		margin: 0;
		padding: 0;
		border: none;
		border-right: 1px solid var(--color-border);
		background: var(--color-bg);
		color: var(--color-text);
		box-shadow: 4px 0 24px color-mix(in srgb, var(--color-text) 25%, transparent);
	}

	.walk-drawer[open] {
		animation: drawer-in 180ms ease-out;
	}

	.walk-drawer::backdrop {
		background: color-mix(in srgb, var(--color-navy-mid) 55%, transparent);
	}

	@keyframes drawer-in {
		from {
			transform: translateX(-100%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.walk-drawer[open] {
			animation: none;
		}
	}

	.drawer-sheet {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		height: 100%;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0 var(--space-4) var(--space-6);
	}

	/* Stays put while the sheet scrolls, so the way out is always in reach. */
	.drawer-head {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-inline: calc(-1 * var(--space-4));
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg);
	}

	.drawer-head h2 {
		margin: 0;
		font-size: var(--font-size-lg);
	}

	.drawer-close {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: 44px;
		padding: 0 var(--space-3);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--color-text);
	}

	.drawer-close:hover {
		background: var(--color-bg-hover);
	}

	.drawer-close:focus-visible {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 2px;
	}
</style>

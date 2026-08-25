<script lang="ts">
	// In-page section navigation for /settings. Owns everything about itself —
	// open state, persistence, the viewport media query, and the scroll spy — so
	// the page only has to render <SettingsNav /> and stamp ids on its sections.
	// The desktop "push" falls out of the flex layout: this is an inline column
	// whose width the content column is centred in what's left of, not an
	// overlay, so nothing is ever covered.
	//
	// Hand-rolled rather than built on bits-ui: every bits-ui disclosure
	// primitive is portal-based, which is exactly the overlay behaviour that
	// would break the push layout, and a <nav><ul><a href="#id"> is natively
	// keyboard-accessible with no JS at all.
	import { browser } from '$app/environment';
	import {
		SETTINGS_SECTIONS,
		SETTINGS_NAV_BREAKPOINT_PX,
		type SettingsNavItem,
	} from './sections.js';
	import { pickActiveAnchorId, allAnchorIds, findParentId } from './nav-active.js';
	import {
		NAV_OPEN_STORAGE_KEY,
		parseNavOpenPref,
		serializeNavOpenPref,
		initialNavOpen,
		shouldPersistNavOpen,
	} from './nav-prefs.js';

	const MEDIA_QUERY = `(max-width: ${SETTINGS_NAV_BREAKPOINT_PX}px)`;

	/** Viewport y-coordinate that decides which section counts as "current".
	 *  Below the sticky mobile bar, and low enough on desktop that a heading has
	 *  visibly arrived before its link lights up. */
	const SCROLL_LINE_PX = 120;

	// SSR renders the desktop default (open) because the server can't know either
	// the stored preference or the viewport. `ready` gates the width transition
	// so the one-frame correction after mount is an instant snap, never an
	// animated slide, and keeps the mobile drawer hidden until we know better.
	let open = $state(true);
	let ready = $state(false);
	let isMobile = $state(false);
	let activeId = $state<string | null>(null);
	let expandedIds = $state<string[]>([]);
	let navEl = $state<HTMLElement>();

	function readStored(): boolean | null {
		if (!browser) return null;
		try {
			return parseNavOpenPref(localStorage.getItem(NAV_OPEN_STORAGE_KEY));
		} catch {
			return null; // Storage disabled (Safari private mode, hardened profiles).
		}
	}

	// Re-derives on every crossing of the breakpoint, so rotating a tablet lands
	// in the right mode instead of keeping a desktop-sized rail on a narrow page.
	$effect(() => {
		const mq = window.matchMedia(MEDIA_QUERY);
		const apply = () => {
			isMobile = mq.matches;
			open = initialNavOpen({ isMobile: mq.matches, stored: readStored() });
		};
		apply();
		ready = true;
		mq.addEventListener('change', apply);
		return () => mq.removeEventListener('change', apply);
	});

	function toggle() {
		open = !open;
		if (!shouldPersistNavOpen(isMobile)) return;
		try {
			localStorage.setItem(NAV_OPEN_STORAGE_KEY, serializeNavOpenPref(open));
		} catch {
			// Storage unavailable — the session still works, it just isn't sticky.
		}
	}

	// Scroll spy. This effect is deliberately thin: measure the anchors once per
	// animation frame and hand plain numbers to `pickActiveAnchorId`, which is
	// where all the decision logic (and all the tests) live.
	$effect(() => {
		const ids = allAnchorIds(SETTINGS_SECTIONS);
		let frame = 0;

		const measure = () => {
			frame = 0;
			const tops = ids
				.map((id) => ({ id, el: document.getElementById(id) }))
				.filter((a): a is { id: string; el: HTMLElement } => a.el !== null)
				.map((a) => ({ id: a.id, top: a.el.getBoundingClientRect().top }));
			activeId = pickActiveAnchorId(tops, {
				line: SCROLL_LINE_PX,
				atBottom: window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2,
			});
		};

		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};

		measure();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
		};
	});

	// Auto-expand the group owning the active anchor. Additive on purpose — it
	// never collapses a group the user opened by hand.
	$effect(() => {
		const parent = activeId ? findParentId(SETTINGS_SECTIONS, activeId) : null;
		if (parent && !expandedIds.includes(parent)) expandedIds = [...expandedIds, parent];
	});

	function toggleGroup(id: string) {
		expandedIds = expandedIds.includes(id)
			? expandedIds.filter((x) => x !== id)
			: [...expandedIds, id];
	}

	// Escape only applies to the mobile drawer — it's the only mode where the nav
	// sits over content. Collapsing the desktop rail on Escape would be a
	// surprise, since nothing is obscured there.
	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !isMobile || !open) return;
		open = false;
		navEl?.querySelector<HTMLElement>('.settings-nav-toggle')?.focus();
	}

	function onLinkClick() {
		if (isMobile) open = false;
	}

	const isCurrent = (item: SettingsNavItem) => item.id === activeId;
</script>

<svelte:window onkeydown={onKeydown} />

<nav
	class="settings-nav"
	bind:this={navEl}
	aria-label="Settings sections"
	data-open={open}
	data-ready={ready}
>
	<button
		type="button"
		class="settings-nav-toggle"
		aria-expanded={open}
		aria-controls="settings-nav-list"
		onclick={toggle}
	>
		<svg
			viewBox="0 0 16 16"
			width="16"
			height="16"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			fill="none"
			aria-hidden="true"
		>
			<path d="M3 4h10M3 8h10M3 12h10" />
		</svg>
		<span class="settings-nav-toggle-label">Sections</span>
	</button>

	<ul id="settings-nav-list" class="settings-nav-list">
		{#each SETTINGS_SECTIONS as item (item.id)}
			<li>
				<div class="settings-nav-row">
					<a
						href="#{item.id}"
						class="settings-nav-link"
						aria-current={isCurrent(item) ? 'true' : undefined}
						onclick={onLinkClick}>{item.label}</a
					>
					{#if item.children}
						<button
							type="button"
							class="settings-nav-disclosure"
							aria-expanded={expandedIds.includes(item.id)}
							aria-controls="settings-nav-sub-{item.id}"
							aria-label="{expandedIds.includes(item.id) ? 'Collapse' : 'Expand'} {item.label}"
							onclick={() => toggleGroup(item.id)}
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
								<path d="M6 4l4 4-4 4" />
							</svg>
						</button>
					{/if}
				</div>
				{#if item.children && expandedIds.includes(item.id)}
					<ul id="settings-nav-sub-{item.id}" class="settings-nav-sublist">
						{#each item.children as child (child.id)}
							<li>
								<a
									href="#{child.id}"
									class="settings-nav-link settings-nav-sublink"
									aria-current={isCurrent(child) ? 'true' : undefined}
									onclick={onLinkClick}>{child.label}</a
								>
							</li>
						{/each}
					</ul>
				{/if}
			</li>
		{/each}
	</ul>
</nav>

<style>
	.settings-nav {
		/* `align-self` is load-bearing: a flex item stretched to the row's height
		 * can't be sticky, because it has nowhere to travel. */
		align-self: flex-start;
		position: sticky;
		top: 0;
		flex: 0 0 auto;
		width: var(--settings-nav-w, 240px);
		/* Full viewport height rather than hugging the list, so the rail's
		 * background and right border read as a column instead of stopping at a
		 * hard edge partway down the page. */
		height: 100vh;
		overflow-y: auto;
		padding: 16px 12px;
		/* Warm off-white rather than the pure-white --color-surface the section
		 * cards use: the rail is chrome, not content, so it sits a step back from
		 * the cards while still lifting off the cream page background. */
		background: var(--color-cream-light);
		border-right: 1px solid var(--color-border);
	}

	/* Collapsed is a thin rail, not a full hide. The toggle stays in normal flow,
	 * so there's no floating button to position and no z-index negotiation with
	 * the page content or the bits-ui tooltip in the settings header. */
	.settings-nav[data-open='false'] {
		width: var(--settings-nav-rail-w, 44px);
		padding: 16px 6px;
		overflow: hidden;
	}

	.settings-nav[data-open='false'] .settings-nav-list,
	.settings-nav[data-open='false'] .settings-nav-toggle-label {
		display: none;
	}

	/* Only animate once the mount effect has read storage and the media query,
	 * so correcting the SSR default snaps instead of sliding. */
	.settings-nav[data-ready='true'] {
		transition: width 160ms ease;
	}

	.settings-nav-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		padding: 6px;
		font: inherit;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.settings-nav-toggle:hover {
		background: color-mix(in srgb, var(--color-text) 6%, transparent);
	}

	.settings-nav-toggle:focus-visible {
		outline: 2px solid var(--color-gold);
		outline-offset: 2px;
	}

	.settings-nav-list,
	.settings-nav-sublist {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
	}

	.settings-nav-sublist {
		margin: 2px 0 6px;
		border-left: 1px solid var(--color-border-subtle);
	}

	.settings-nav-row {
		display: flex;
		align-items: center;
	}

	.settings-nav-link {
		flex: 1 1 auto;
		display: block;
		padding: 5px 8px;
		border-radius: var(--radius-sm);
		color: var(--color-text);
		text-decoration: none;
		font-size: var(--font-size-base);
		line-height: 1.3;
	}

	.settings-nav-sublink {
		margin-left: 8px;
		font-size: var(--font-size-sm);
		color: var(--color-text-muted);
	}

	.settings-nav-link:hover {
		background: color-mix(in srgb, var(--color-text) 6%, transparent);
	}

	.settings-nav-link:focus-visible {
		outline: 2px solid var(--color-gold);
		outline-offset: -2px;
	}

	.settings-nav-link[aria-current='true'] {
		font-weight: 600;
		color: var(--color-text);
		background: color-mix(in srgb, var(--color-gold) 22%, transparent);
		box-shadow: inset 2px 0 0 var(--color-gold);
	}

	.settings-nav-disclosure {
		flex: 0 0 auto;
		display: inline-flex;
		background: transparent;
		border: none;
		padding: 4px;
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.settings-nav-disclosure:focus-visible {
		outline: 2px solid var(--color-gold);
		outline-offset: 1px;
		border-radius: var(--radius-sm);
	}

	.settings-nav-disclosure svg {
		transition: transform 120ms ease;
	}

	.settings-nav-disclosure[aria-expanded='true'] svg {
		transform: rotate(90deg);
	}

	/* Narrow: the rail becomes a bar pinned to the top of the viewport, with the
	 * list dropping over the content beneath it. `position: sticky` resolves
	 * against the viewport scroller (the app header is static and scrolls away),
	 * which beats `position: fixed` here — no reserved-space hack, no jump, and
	 * the bar correctly stops at the bottom of the page. */
	@media (max-width: 960px) {
		.settings-nav {
			position: sticky;
			top: 0;
			z-index: 20;
			width: auto;
			height: var(--settings-nav-bar-h, 44px);
			overflow: visible; /* the dropped panel has to escape the bar */
			display: flex;
			align-items: center;
			padding: 0 12px;
			border-right: none;
			border-bottom: 1px solid var(--color-border);
		}

		.settings-nav[data-open='false'] {
			width: auto;
			padding: 0 12px;
			overflow: visible;
		}

		.settings-nav[data-ready='true'] {
			transition: none;
		}

		.settings-nav[data-open='false'] .settings-nav-toggle-label {
			display: inline;
		}

		.settings-nav-toggle {
			width: auto;
		}

		/* The bar keeps a fixed height and the list is positioned out of flow, so
		 * opening the drawer never reflows the page under the reading position. */
		.settings-nav-list {
			position: absolute;
			top: 100%;
			left: 0;
			right: 0;
			margin: 0;
			max-height: calc(100vh - var(--settings-nav-bar-h, 44px));
			overflow-y: auto;
			padding: 8px 12px 12px;
			/* Matches the bar it drops out of, so the two read as one surface. */
			background: var(--color-cream-light);
			border-bottom: 1px solid var(--color-border);
			box-shadow: var(--shadow-popover);
		}

		/* Pre-hydration the SSR default is "open" (the desktop default), so hide
		 * the dropped panel until the mount effect has decided — a phone should
		 * never paint an open drawer, even for one frame. */
		.settings-nav[data-ready='false'] .settings-nav-list,
		.settings-nav[data-open='false'] .settings-nav-list {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.settings-nav,
		.settings-nav-disclosure svg {
			transition: none;
		}
	}
</style>

// Scroll-spy decision logic for the /settings sidebar, extracted from
// SettingsNav.svelte so it's unit-testable — vitest runs with
// `environment: 'node'` here, so anything touching the DOM can't be covered.
// The component keeps only the measuring (getBoundingClientRect per anchor,
// once per animation frame) and hands the numbers to `pickActiveAnchorId`.
//
// Deliberately rect math rather than IntersectionObserver: several App-config
// rows (the ticker preview, the welcome-DM editor) are taller than a viewport,
// and an observer fires no callbacks at all while you scroll through one — the
// highlight would freeze on whichever row you entered from.

import type { SettingsNavItem } from './sections.js';

export interface AnchorTop {
	id: string;
	/** `getBoundingClientRect().top` — distance from the viewport top; goes
	 *  negative once the element has scrolled above the fold. */
	top: number;
}

export interface PickActiveOptions {
	/** Viewport y-coordinate that decides which anchor counts as current. */
	line: number;
	/** True when the page is scrolled to the bottom. Without it the last, short
	 *  sections could never become active — they never reach `line`. */
	atBottom?: boolean;
}

/**
 * Picks the anchor that should be marked current.
 *
 *  - no anchors           → null
 *  - scrolled to bottom   → the last anchor in document order
 *  - otherwise            → the last anchor whose top is at or above `line`
 *  - none above the line  → the first anchor (page is still above section one)
 *
 * Input need not be sorted by `top`; document order is taken from array order,
 * and ties on `top` resolve to the later entry (the one further down the page).
 */
export function pickActiveAnchorId(
	anchors: readonly AnchorTop[],
	opts: PickActiveOptions,
): string | null {
	if (anchors.length === 0) return null;
	if (opts.atBottom) return anchors[anchors.length - 1].id;

	let active: AnchorTop | null = null;
	for (const anchor of anchors) {
		// `<=` so an anchor sitting exactly on the line counts as reached.
		if (anchor.top <= opts.line && (active === null || anchor.top >= active.top)) {
			active = anchor;
		}
	}
	return (active ?? anchors[0]).id;
}

/** Every anchor id in document order — each parent immediately followed by its
 *  own children, which is how they're laid out on the page. */
export function allAnchorIds(tree: readonly SettingsNavItem[]): string[] {
	const ids: string[] = [];
	for (const item of tree) {
		ids.push(item.id);
		for (const child of item.children ?? []) ids.push(child.id);
	}
	return ids;
}

/** The top-level id owning `id`, or null when `id` is itself top-level or
 *  unknown. Drives auto-expanding the App config group as you scroll into it. */
export function findParentId(tree: readonly SettingsNavItem[], id: string): string | null {
	for (const item of tree) {
		if (item.children?.some((child) => child.id === id)) return item.id;
	}
	return null;
}

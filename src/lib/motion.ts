// The viewer's reduced-motion preference, for motion the stylesheet can't
// turn off: scrolling and animation started from script.

export function prefersReducedMotion(): boolean {
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** A scroll's `behavior`: smooth, unless the viewer asked for less motion. */
export function scrollBehavior(): ScrollBehavior {
	return prefersReducedMotion() ? 'auto' : 'smooth';
}

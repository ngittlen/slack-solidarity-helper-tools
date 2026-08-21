// The viewer's theme preference: follow the device, or force one.
//
// Pure and shared. The server reads the cookie to stamp `data-theme` on <html>
// before the page is sent — that is what stops a flash of the wrong palette —
// and the toggle writes the same cookie so a reload agrees with what the user
// just picked.
//
// Three states, not two. Dropping "system" would be a regression: the emitted
// stylesheet already follows prefers-color-scheme by default, and a viewer who
// has their OS on a schedule expects the app to move with it. So the button
// cycles system → light → dark → system.

export type ThemeMode = 'system' | 'light' | 'dark';

/** Read by hooks.server.ts, written by the toggle. Not httpOnly on purpose —
 *  the client has to set it without a round-trip. Nothing sensitive is in it. */
export const THEME_COOKIE = 'theme';

/** A year: this is a preference, not a session. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

/** Anything unrecognised — absent cookie, stale value, hand-edited nonsense —
 *  means "follow the device", which is the safe default. */
export function parseThemeMode(raw: string | undefined | null): ThemeMode {
	return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
	const i = THEME_MODES.indexOf(mode);
	return THEME_MODES[(i + 1) % THEME_MODES.length];
}

/**
 * The attribute to stamp on <html>, including its leading space.
 *
 * Empty for 'system' — the absence of `data-theme` is what lets the
 * prefers-color-scheme media query take over, and the emitted CSS is written
 * around exactly that (`:root:not([data-theme="light"])`).
 */
export function themeAttribute(mode: ThemeMode): string {
	return mode === 'system' ? '' : ` data-theme="${mode}"`;
}

/** Label for the button, describing what a tap will DO rather than what the
 *  current state is — the icon already shows the state. */
export function themeToggleLabel(mode: ThemeMode): string {
	switch (mode) {
		case 'system':
			return 'Theme: following your device. Tap for light.';
		case 'light':
			return 'Theme: light. Tap for dark.';
		case 'dark':
			return 'Theme: dark. Tap to follow your device.';
	}
}

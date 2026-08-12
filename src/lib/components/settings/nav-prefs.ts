// Persistence rules for the /settings sidebar's open state, kept out of
// SettingsNav.svelte so they're unit-testable without a DOM (vitest runs with
// `environment: 'node'`). The component owns the try/catch around
// `localStorage` itself; everything here is pure.

/** Namespaced so the key can't collide with anything else on the origin. This
 *  is the first use of localStorage in this codebase. */
export const NAV_OPEN_STORAGE_KEY = 'a4m:settings-nav-open';

/** `'1'`/`'0'` → boolean. Anything else — absent, corrupt, or written by an
 *  older build — is `null`, meaning "no stored preference, use the default". */
export function parseNavOpenPref(raw: string | null): boolean | null {
	if (raw === '1') return true;
	if (raw === '0') return false;
	return null;
}

export function serializeNavOpenPref(open: boolean): string {
	return open ? '1' : '0';
}

/**
 * The open state to start with.
 *
 * Mobile always starts closed regardless of what's stored: the narrow layout
 * puts the nav in a drawer over the content, and restoring that open on load
 * would cover the page you came to read. The stored flag is desktop-only in
 * both directions — see `shouldPersistNavOpen`.
 */
export function initialNavOpen(opts: {
	isMobile: boolean;
	stored: boolean | null;
	/** Desktop first-visit default. Open, so the feature is discoverable. */
	defaultOpen?: boolean;
}): boolean {
	if (opts.isMobile) return false;
	return opts.stored ?? opts.defaultOpen ?? true;
}

/** Toggling the mobile drawer is transient — it must never overwrite the
 *  desktop preference, or collapsing the drawer on a phone would silently
 *  collapse the sidebar on the same user's laptop. */
export function shouldPersistNavOpen(isMobile: boolean): boolean {
	return !isMobile;
}

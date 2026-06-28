// Format a millisecond delta as a coarse human-readable "ago" label for the
// `/settings` page's "Last refreshed Nm ago" indicator (NAV-3, FR-008).
//
// The breakpoints are intentionally coarse — admins don't need second-level
// precision on cache age, they need to know whether to click "Refresh lists".
// See specs/007-settings-shell-primitives/research.md#R3 for the rationale.

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatRelative(deltaMs: number): string {
	// Negative deltas (clock skew between server and client) are clamped to 0
	// rather than rendered as "in N minutes" — the indicator is past-only.
	const ms = Math.max(0, deltaMs);
	if (ms < MIN_MS) return 'just now';
	if (ms < HOUR_MS) return `${Math.floor(ms / MIN_MS)}m ago`;
	if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h ago`;
	const days = Math.floor(ms / DAY_MS);
	return `${days} day${days === 1 ? '' : 's'} ago`;
}

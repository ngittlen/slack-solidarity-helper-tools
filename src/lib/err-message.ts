// Shared error-to-string helper, importable from both server modules and
// Svelte components (no $env/$lib/server imports).

/** The human-readable message of an unknown thrown value. */
export function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

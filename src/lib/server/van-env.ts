// Env → the VAN client, and the only file in the app that knows VAN
// credentials exist. Everything under src/lib/server/van/ takes an injected
// client, so this is the single seam where configuration meets the network.
//
// Shaped exactly like door-knock-env.ts: a discriminated result rather than a
// throw, because the app must run normally with VAN unconfigured. A dashboard
// that 500s because nobody has finished the EveryAction security review is a
// worse outcome than a turf page that says "not configured yet".
//
// Note there is no VAN_TURF_FOLDER_IDS. Folder ids come from the
// van_chapter_folders table, edited in /settings — turf has to be attributed
// to a chapter to be servable at all (see plan.md §3), so an env var listing
// folders would be a second, conflicting source of truth.

import { VAN_APP_NAME, VAN_API_KEY, VAN_DATABASE_MODE, VAN_EXPORT_JOB_TYPE_ID } from './env.js';
import { createVanClient, type VanClient, type VanDatabaseMode } from './van/client.js';

export type VanClientResult = { ok: true; client: VanClient } | { ok: false; error: string };

/** Parse VAN_DATABASE_MODE. Deliberately strict: '' and '2' are errors, not
 *  silent falls back to 0, because the wrong mode authenticates successfully
 *  and returns an empty-looking database — a failure that reads as "the
 *  campaign has no turf" rather than as a misconfiguration. */
function parseDatabaseMode(raw: string): VanDatabaseMode | null {
	if (raw === '0') return 0;
	if (raw === '1') return 1;
	return null;
}

/** The configured VAN client, or why there isn't one. */
export function vanClient(): VanClientResult {
	if (!VAN_APP_NAME || !VAN_API_KEY) {
		return { ok: false, error: 'VAN_APP_NAME/VAN_API_KEY are not set' };
	}
	const databaseMode = parseDatabaseMode(VAN_DATABASE_MODE);
	if (databaseMode === null) {
		return {
			ok: false,
			error: `VAN_DATABASE_MODE must be 0 (My Voters) or 1 (My Campaign), got "${VAN_DATABASE_MODE}"`,
		};
	}
	return {
		ok: true,
		client: createVanClient({ appName: VAN_APP_NAME, apiKey: VAN_API_KEY, databaseMode }),
	};
}

/** True when VAN is fully configured. Callers that must stay silent when the
 *  integration simply isn't set up (the turf page, the dashboard) use this
 *  rather than surfacing the error text. */
export function isVanConfigured(): boolean {
	return vanClient().ok;
}

/** The export job type id for the coordinates-only geometry export, or null
 *  when unset. Separate from vanClient() because the catalog sync works
 *  without it — only hull geometry is blocked. */
export function vanExportJobTypeId(): number | null {
	return Number.isFinite(VAN_EXPORT_JOB_TYPE_ID) && VAN_EXPORT_JOB_TYPE_ID > 0
		? VAN_EXPORT_JOB_TYPE_ID
		: null;
}

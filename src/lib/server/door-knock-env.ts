// Env → runDoorKnockSnapshot dependencies, shared by the two callers that
// trigger a snapshot: the scheduled internal endpoint and the dashboard's
// on-demand refresh. Kept out of door-knock-snapshot.ts / door-knock-refresh.ts
// so those stay free of $env imports and trivially testable.

import {
	SLACK_BOT_TOKEN,
	OPENFIELD_BASE_URL,
	OPENFIELD_USERNAME,
	OPENFIELD_PASSWORD,
	DOOR_KNOCK_CHANNEL_ID,
} from './env.js';
import { fetchConversationCodesCanvas } from './door-knock-canvas.js';
import { createOpenfieldClient } from './openfield.js';
import type { DoorKnockSnapshotDeps } from './door-knock-snapshot.js';

export type DoorKnockDepsResult =
	{ ok: true; deps: DoorKnockSnapshotDeps } | { ok: false; error: string };

/** True when every env var the snapshot needs is set. Callers that must not
 *  surface an error (the dashboard) use this to stay silent when the Openfield
 *  integration simply isn't configured. */
export function isDoorKnockConfigured(): boolean {
	return doorKnockSnapshotDeps().ok;
}

export function doorKnockSnapshotDeps(): DoorKnockDepsResult {
	if (!OPENFIELD_BASE_URL || !OPENFIELD_USERNAME || !OPENFIELD_PASSWORD) {
		return { ok: false, error: 'OPENFIELD_BASE_URL/USERNAME/PASSWORD are not set' };
	}
	if (!DOOR_KNOCK_CHANNEL_ID) {
		return { ok: false, error: 'DOOR_KNOCK_CHANNEL_ID is not set' };
	}
	return {
		ok: true,
		deps: {
			fetchCanvasHtml: () => fetchConversationCodesCanvas(SLACK_BOT_TOKEN, DOOR_KNOCK_CHANNEL_ID),
			openfield: createOpenfieldClient({
				baseUrl: OPENFIELD_BASE_URL,
				username: OPENFIELD_USERNAME,
				password: OPENFIELD_PASSWORD,
			}),
		},
	};
}

// Env → the door-knock provider, and the one place that knows which providers
// exist. Kept out of door-knock-snapshot.ts / door-knock-refresh.ts so those
// stay free of $env imports and trivially testable.
//
// Adding a provider: implement DoorKnockProvider (see door-knock-provider.ts),
// add its env vars to env.ts, and add a branch to buildProvider below. Nothing
// else in the app selects a provider.

import {
	SLACK_BOT_TOKEN,
	DOOR_KNOCK_PROVIDER,
	OPENFIELD_BASE_URL,
	OPENFIELD_USERNAME,
	OPENFIELD_PASSWORD,
	DOOR_KNOCK_CHANNEL_ID,
} from './env.js';
import { db } from './db.js';
import type { DoorKnockProvider } from './door-knock-provider.js';
import {
	fetchConversationCodesCanvas,
	findCodesCanvasFile,
} from './door-knock/openfield/canvas.js';
import { createCanvasWatcher, type CanvasWatcher } from './door-knock/openfield/canvas-watch.js';
import { createOpenfieldClient } from './door-knock/openfield/client.js';
import { createOpenfieldProvider } from './door-knock/openfield/provider.js';

export type DoorKnockProviderResult =
	{ ok: true; provider: DoorKnockProvider } | { ok: false; error: string };

function buildOpenfieldProvider(): DoorKnockProviderResult {
	if (!OPENFIELD_BASE_URL || !OPENFIELD_USERNAME || !OPENFIELD_PASSWORD) {
		return { ok: false, error: 'OPENFIELD_BASE_URL/USERNAME/PASSWORD are not set' };
	}
	if (!DOOR_KNOCK_CHANNEL_ID) {
		return { ok: false, error: 'DOOR_KNOCK_CHANNEL_ID is not set' };
	}
	return {
		ok: true,
		provider: createOpenfieldProvider({
			db,
			fetchCanvasHtml: () => fetchConversationCodesCanvas(SLACK_BOT_TOKEN, DOOR_KNOCK_CHANNEL_ID),
			client: createOpenfieldClient({
				baseUrl: OPENFIELD_BASE_URL,
				username: OPENFIELD_USERNAME,
				password: OPENFIELD_PASSWORD,
			}),
		}),
	};
}

/** The configured door-knock provider, or why there isn't one. Defaults to
 *  Openfield so existing deployments need no new env var. */
export function doorKnockProvider(): DoorKnockProviderResult {
	const name = DOOR_KNOCK_PROVIDER || 'openfield';
	switch (name) {
		case 'openfield':
			return buildOpenfieldProvider();
		default:
			return { ok: false, error: `unknown DOOR_KNOCK_PROVIDER "${name}"` };
	}
}

/** True when a provider is fully configured. Callers that must not surface an
 *  error (the dashboard) use this to stay silent when the door-knock
 *  integration simply isn't set up. */
export function isDoorKnockConfigured(): boolean {
	return doorKnockProvider().ok;
}

/** The Slack canvas watcher, when the configured provider has one.
 *
 *  This is Openfield-only by nature: it exists because Openfield's conversation
 *  codes are published on a hand-edited Slack canvas and a code can be swapped
 *  out the same day it appears, so the ids must be captured while the canvas
 *  entry still exists. A provider that reads dated history needs nothing like
 *  it — hence null rather than a no-op watcher, so the Slack events route can
 *  skip the work entirely. */
export function doorKnockCanvasWatcher(): CanvasWatcher | null {
	const usingOpenfield = (DOOR_KNOCK_PROVIDER || 'openfield') === 'openfield';
	if (
		!usingOpenfield ||
		!DOOR_KNOCK_CHANNEL_ID ||
		!OPENFIELD_BASE_URL ||
		!OPENFIELD_USERNAME ||
		!OPENFIELD_PASSWORD
	) {
		return null;
	}
	return createCanvasWatcher({
		db,
		findCanvasFileId: async () =>
			(await findCodesCanvasFile(SLACK_BOT_TOKEN, DOOR_KNOCK_CHANNEL_ID)).fileId,
		fetchCanvasHtml: () => fetchConversationCodesCanvas(SLACK_BOT_TOKEN, DOOR_KNOCK_CHANNEL_ID),
		openfield: createOpenfieldClient({
			baseUrl: OPENFIELD_BASE_URL,
			username: OPENFIELD_USERNAME,
			password: OPENFIELD_PASSWORD,
		}),
	});
}

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { runDoorKnockSnapshot } from '$lib/server/door-knock-snapshot.js';
import { fetchConversationCodesCanvas } from '$lib/server/door-knock-canvas.js';
import { createOpenfieldClient } from '$lib/server/openfield.js';
import {
	INTERNAL_CRON_SECRET,
	SLACK_BOT_TOKEN,
	OPENFIELD_BASE_URL,
	OPENFIELD_USERNAME,
	OPENFIELD_PASSWORD,
	DOOR_KNOCK_CHANNEL_ID,
} from '$lib/server/env.js';

// Internal endpoint called by a scheduler near the end of the canvassing day
// (Openfield's leaderboard is today-only, so this freezes today's totals).
// Auth via ?key=<INTERNAL_CRON_SECRET>, same as the solidarity snapshot.
export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[door-knock] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (url.searchParams.get('key') !== INTERNAL_CRON_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	if (!OPENFIELD_BASE_URL || !OPENFIELD_USERNAME || !OPENFIELD_PASSWORD) {
		return json({ error: 'OPENFIELD_BASE_URL/USERNAME/PASSWORD are not set' }, { status: 500 });
	}
	if (!DOOR_KNOCK_CHANNEL_ID) {
		return json({ error: 'DOOR_KNOCK_CHANNEL_ID is not set' }, { status: 500 });
	}

	try {
		const result = await runDoorKnockSnapshot(db, {
			fetchCanvasHtml: () => fetchConversationCodesCanvas(SLACK_BOT_TOKEN, DOOR_KNOCK_CHANNEL_ID),
			openfield: createOpenfieldClient({
				baseUrl: OPENFIELD_BASE_URL,
				username: OPENFIELD_USERNAME,
				password: OPENFIELD_PASSWORD,
			}),
		});
		console.log(
			`[door-knock] ${result.date}: ${result.rowsWritten} rows, ${result.totalAttempts} attempts` +
				(result.codesFailed.length > 0 ? `, failed: ${result.codesFailed.join(',')}` : ''),
		);
		return json(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[door-knock] failed:', msg);
		return json({ error: msg }, { status: 500 });
	}
};

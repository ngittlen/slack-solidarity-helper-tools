import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { loadSettings } from '$lib/server/settings.js';
import { runDoorKnockSnapshot, UNMAPPED_CHAPTER } from '$lib/server/door-knock-snapshot.js';
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

		// Parser-drift alarm only: codes the parser couldn't attribute to a
		// chapter (counted under "Unmapped") need a human to fix the parser or
		// the canvas. Off-canvas codes are routine (mid-day swaps) and handled
		// silently. Best-effort — a Slack outage must not fail the snapshot
		// that already ran.
		if (result.unattributedCodes.length > 0) {
			try {
				const { slackTrackingChannelId } = await loadSettings(db);
				await slack.chat.postMessage({
					channel: slackTrackingChannelId,
					text:
						`:warning: Door-knock snapshot: ${result.unattributedCodes.length} code(s) on the canvas ` +
						`couldn't be matched to a chapter (layout may have changed): ${result.unattributedCodes.join(', ')} — ` +
						`counted under “${UNMAPPED_CHAPTER}” until the canvas or the parser is fixed.`,
				});
			} catch (err) {
				console.error(
					'[door-knock] failed to post canvas-drift warning to Slack:',
					err instanceof Error ? err.message : err,
				);
			}
		}

		return json(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[door-knock] failed:', msg);
		return json({ error: msg }, { status: 500 });
	}
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { runWeeklyGrowthReport } from '$lib/server/weekly-growth-report.js';
import {
	INTERNAL_CRON_SECRET,
	REPORT_EXCLUDED_CHAPTER_IDS,
	SLACK_GROWTH_REPORT_CHANNEL_ID,
	SLACK_GROWTH_REPORT_RANKING_ALPHA,
	SOLIDARITY_CHAPTER_CHANNEL_MAP,
} from '$lib/server/env.js';

// Internal endpoint called by a scheduler (GitHub Actions) to compute and post
// the weekly per-chapter Slack-growth leaderboard. Auth via ?key=<INTERNAL_CRON_SECRET>.
// Optional ?dry_run=1 returns the result without posting to Slack.
export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[growth] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (url.searchParams.get('key') !== INTERNAL_CRON_SECRET) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	if (!SLACK_GROWTH_REPORT_CHANNEL_ID) {
		return json({ error: 'SLACK_GROWTH_REPORT_CHANNEL_ID is not set' }, { status: 500 });
	}

	const dryRun = url.searchParams.get('dry_run') === '1';

	try {
		const chapterChannelIds = new Map<number, string>(
			SOLIDARITY_CHAPTER_CHANNEL_MAP.map((c) => [c.chapterId, c.channelId]),
		);
		const result = await runWeeklyGrowthReport(db, slack, SLACK_GROWTH_REPORT_CHANNEL_ID, {
			dryRun,
			excludedChapterIds: REPORT_EXCLUDED_CHAPTER_IDS,
			chapterChannelIds,
			rankingAlpha: SLACK_GROWTH_REPORT_RANKING_ALPHA,
		});
		console.log(
			`[growth] ${result.windowStart} → ${result.windowEnd}: ${result.chaptersWithGrowth} chapters, ${result.totalNewJoins} new joins, posted=${result.posted}`,
		);
		return json(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error('[growth] failed:', msg);
		return json({ error: msg }, { status: 500 });
	}
};

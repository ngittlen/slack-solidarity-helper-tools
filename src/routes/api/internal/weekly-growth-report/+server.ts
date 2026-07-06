import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { runWeeklyGrowthReport, firstChannelByChapter } from '$lib/server/weekly-growth-report.js';
import { loadSettings } from '$lib/server/settings.js';
import { INTERNAL_CRON_SECRET } from '$lib/server/env.js';

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

	const dryRun = url.searchParams.get('dry_run') === '1';

	try {
		// Admin-editable settings (DB-backed, env fallback for the app_config
		// fields) — must agree with the dashboard and team_join invites.
		const settings = await loadSettings(db);
		if (!settings.slackGrowthReportChannelId) {
			return json({ error: 'Growth report channel is not configured' }, { status: 500 });
		}
		const chapterChannelIds = firstChannelByChapter(settings.chapterChannelMap);
		const result = await runWeeklyGrowthReport(db, slack, settings.slackGrowthReportChannelId, {
			dryRun,
			excludedChapterIds: settings.reportExcludedChapterIds,
			chapterChannelIds,
			rankingAlpha: settings.slackGrowthReportRankingAlpha,
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

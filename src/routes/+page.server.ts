import type { PageServerLoad } from './$types';
import { loadDashboardPageData } from '$lib/server/dashboard-page-load.js';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import {
	computeWeeklyLeaderboard,
	computeLiveLeaderboardSinceSnapshot,
	type WeeklyLeaderboard,
	type LeaderboardResult,
	type LeaderboardPair,
} from '$lib/server/weekly-growth-report.js';
import {
	REPORT_EXCLUDED_CHAPTER_IDS,
	SLACK_GROWTH_REPORT_RANKING_ALPHA,
	SOLIDARITY_CHAPTER_CHANNEL_MAP,
} from '$lib/server/env.js';

async function safeLoad(
	label: string,
	compute: () => Promise<WeeklyLeaderboard>,
): Promise<LeaderboardResult> {
	try {
		return { ok: true, leaderboard: await compute() };
	} catch (err) {
		console.error(
			`[dashboard] ${label} leaderboard load failed:`,
			err instanceof Error ? err.message : err,
		);
		return { ok: false, error: 'Failed to load leaderboard. Please try again.' };
	}
}

export const load: PageServerLoad = async (event) => {
	const base = await loadDashboardPageData(event);

	const chapterChannelIds = new Map<number, string>(
		SOLIDARITY_CHAPTER_CHANNEL_MAP.map((c) => [c.chapterId, c.channelId]),
	);

	const opts = {
		excludedChapterIds: REPORT_EXCLUDED_CHAPTER_IDS,
		chapterChannelIds,
		rankingAlpha: SLACK_GROWTH_REPORT_RANKING_ALPHA,
	};

	const [saved, live] = await Promise.all([
		// Saved tab stays the frozen snapshot; only the live tab fetches the
		// current Slack channel sizes.
		safeLoad('saved', () => computeWeeklyLeaderboard(db, opts)),
		safeLoad('live', () => computeLiveLeaderboardSinceSnapshot(db, { ...opts, slack })),
	]);

	const leaderboard: LeaderboardPair = { saved, live };

	return { ...base, leaderboard, pageTitle: 'Dashboard' };
};

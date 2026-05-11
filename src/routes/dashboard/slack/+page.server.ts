import type { PageServerLoad } from './$types';
import { loadDashboardPageData } from '$lib/server/dashboard-page-load.js';
import { db } from '$lib/server/db.js';
import {
	computeWeeklyLeaderboard,
	type WeeklyLeaderboard,
} from '$lib/server/weekly-growth-report.js';
import {
	REPORT_EXCLUDED_CHAPTER_IDS,
	SLACK_GROWTH_REPORT_RANKING_ALPHA,
	SOLIDARITY_CHAPTER_CHANNEL_MAP,
} from '$lib/server/env.js';

export type LeaderboardResult =
	| { ok: true; leaderboard: WeeklyLeaderboard }
	| { ok: false; error: string };

export const load: PageServerLoad = async (event) => {
	const base = await loadDashboardPageData(event);

	const chapterChannelIds = new Map<number, string>(
		SOLIDARITY_CHAPTER_CHANNEL_MAP.map((c) => [c.chapterId, c.channelId]),
	);

	let leaderboard: LeaderboardResult;
	try {
		const result = await computeWeeklyLeaderboard(db, {
			excludedChapterIds: REPORT_EXCLUDED_CHAPTER_IDS,
			chapterChannelIds,
			rankingAlpha: SLACK_GROWTH_REPORT_RANKING_ALPHA,
		});
		leaderboard = { ok: true, leaderboard: result };
	} catch (err) {
		console.error(
			'[dashboard] leaderboard load failed:',
			err instanceof Error ? err.message : err,
		);
		leaderboard = { ok: false, error: 'Failed to load leaderboard. Please try again.' };
	}

	return { ...base, leaderboard };
};

import type { PageServerLoad } from './$types';
import { loadDashboardPageData } from '$lib/server/dashboard-page-load.js';
import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import {
	computeWeeklyLeaderboard,
	computeLiveLeaderboardSinceSnapshot,
	firstChannelByChapter,
	type WeeklyLeaderboard,
	type LeaderboardResult,
	type LeaderboardPair,
} from '$lib/server/weekly-growth-report.js';
import { loadSettings } from '$lib/server/settings.js';
import {
	loadDoorKnockDayTotals,
	projectDoorsAtDeadline,
} from '$lib/server/door-knock-projection.js';
import {
	computeDoorsLeaderboardPair,
	type DoorsLeaderboardPair,
} from '$lib/server/door-knock-leaderboard.js';

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

	// Same admin-editable settings the team_join invites use — the leaderboard's
	// channel links and exclusions must agree with what /settings shows.
	const settings = await loadSettings(db);
	const chapterChannelIds = firstChannelByChapter(settings.chapterChannelMap);

	const opts = {
		excludedChapterIds: settings.reportExcludedChapterIds,
		chapterChannelIds,
		rankingAlpha: settings.slackGrowthReportRankingAlpha,
	};

	const [saved, live] = await Promise.all([
		// Saved tab stays the frozen snapshot; only the live tab fetches the
		// current Slack channel sizes.
		safeLoad('saved', () => computeWeeklyLeaderboard(db, opts)),
		safeLoad('live', () => computeLiveLeaderboardSinceSnapshot(db, { ...opts, slack })),
	]);

	const leaderboard: LeaderboardPair = { saved, live };

	// Doors-knocked leaderboard — same α, week windows from door_knock_daily.
	// A failure degrades both tabs rather than the whole page.
	let doorsLeaderboard: DoorsLeaderboardPair;
	try {
		doorsLeaderboard = await computeDoorsLeaderboardPair(db, {
			rankingAlpha: settings.slackGrowthReportRankingAlpha,
		});
	} catch (err) {
		console.error(
			'[dashboard] doors leaderboard load failed:',
			err instanceof Error ? err.message : err,
		);
		const failed = { ok: false as const, error: 'Failed to load leaderboard. Please try again.' };
		doorsLeaderboard = { lastWeek: failed, thisWeek: failed };
	}

	// Dashboard countdown banner, from the same settings read as the
	// leaderboard opts. Absent end datetime = no banner. When door-knock
	// snapshots exist, the banner also shows the projected doors knocked by
	// the deadline (recent pace extrapolated over the time remaining) —
	// best-effort, so a failure just hides the projection line.
	let countdown: { label: string; endAt: string; projectedDoors: number | null } | null = null;
	if (settings.countdownEndAt !== '') {
		let projectedDoors: number | null = null;
		try {
			const dayTotals = await loadDoorKnockDayTotals(db);
			projectedDoors = projectDoorsAtDeadline(
				dayTotals,
				Date.parse(settings.countdownEndAt),
				Date.now(),
			);
		} catch (err) {
			console.error(
				'[dashboard] door-knock projection failed:',
				err instanceof Error ? err.message : err,
			);
		}
		countdown = { label: settings.countdownLabel, endAt: settings.countdownEndAt, projectedDoors };
	}

	return { ...base, leaderboard, doorsLeaderboard, countdown, pageTitle: 'Dashboard' };
};

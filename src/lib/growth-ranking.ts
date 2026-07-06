// Growth-report ranking math, shared between the server compute paths
// (weekly-growth-report.ts) and the /settings App-config alpha-slider preview,
// which re-ranks the current leaderboard client-side as the slider moves. No
// server imports — this must stay importable from browser code.

/** How many chapters the report and dashboard leaderboards display. */
export const TOP_N = 5;

// Power-law exponent for the ranking score: score = newJoins / (existing + 1)^α
//   α = 1   → pure relative growth (small chapters dominate)
//   α = 0.7 → small chapters still tend to win, large ones become competitive
//   α = 0.5 → square-root denominator, large chapters favored
//   α = 0   → pure absolute count
// The +1 in the denominator avoids dividing by zero for brand-new chapters.
export const DEFAULT_RANKING_ALPHA = 0.5;

export interface RankableChapter {
	newJoins: number;
	existing: number;
}

export function rankingScore(c: RankableChapter, alpha: number): number {
	return c.newJoins / Math.pow(c.existing + 1, alpha);
}

export function sortByRanking<T extends RankableChapter>(rows: T[], alpha: number): void {
	rows.sort((a, b) => {
		const sa = rankingScore(a, alpha);
		const sb = rankingScore(b, alpha);
		if (sb !== sa) return sb - sa;
		return b.newJoins - a.newJoins;
	});
}

/** Non-mutating rank-and-trim, for re-ranking an existing leaderboard. */
export function reRank<T extends RankableChapter>(
	chapters: readonly T[],
	alpha: number,
	topN: number = TOP_N,
): T[] {
	const copy = [...chapters];
	sortByRanking(copy, alpha);
	return copy.slice(0, topN);
}

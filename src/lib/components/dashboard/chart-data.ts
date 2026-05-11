import type { DaySignups } from '$lib/server/dashboard-signups.js';

export const DASHBOARD_TOP_N = 10;
export const OTHER_BAND_LABEL = 'Other';
export const NO_CHAPTER_BAND_LABEL = 'No chapter';

export interface ChartBand {
	key: string;
	label: string;
	values: number[];
	mergedChapters?: Array<{
		chapterId: number;
		chapterName: string;
		values: number[];
		totalInWindow: number;
	}>;
}

export interface ChartFrame {
	dates: string[];
	bands: ChartBand[];
	dailyTotals?: number[];
}

function addDays(date: string, n: number): string {
	const [y, m, d] = date.split('-').map(Number);
	const t = Date.UTC(y!, m! - 1, d! + n);
	return new Date(t).toISOString().slice(0, 10);
}

function contiguousDates(input: DaySignups[]): string[] {
	if (input.length === 0) return [];
	const first = input[0]!.date;
	const last = input[input.length - 1]!.date;
	const dates: string[] = [];
	let cursor = first;
	while (cursor <= last) {
		dates.push(cursor);
		cursor = addDays(cursor, 1);
	}
	return dates;
}

export function buildOverviewFrame(days: DaySignups[], sourceLabel: string): ChartFrame {
	if (days.length === 0) {
		return { dates: [], bands: [] };
	}
	const dates = contiguousDates(days);
	const totalsByDate = new Map<string, number>();
	for (const d of days) totalsByDate.set(d.date, d.total);
	const values = dates.map((d) => totalsByDate.get(d) ?? 0);
	return {
		dates,
		bands: [
			{
				key: 'total',
				label: `${sourceLabel} signups`,
				values,
			},
		],
	};
}

export function buildDetailFrame(days: DaySignups[]): ChartFrame {
	if (days.length === 0) {
		return { dates: [], bands: [] };
	}

	const dates = contiguousDates(days);
	const dateIndex = new Map<string, number>();
	dates.forEach((d, i) => dateIndex.set(d, i));

	interface ChapterAccum {
		chapterId: number;
		chapterName: string;
		values: number[];
		totalInWindow: number;
	}

	const chapters = new Map<number, ChapterAccum>();
	const nullValues = new Array(dates.length).fill(0) as number[];
	let nullHasAny = false;

	for (const day of days) {
		const idx = dateIndex.get(day.date);
		if (idx === undefined) continue;
		for (const c of day.byChapter) {
			if (c.chapterId === null || c.chapterName === null) {
				nullValues[idx]! += c.count;
				if (c.count > 0) nullHasAny = true;
				continue;
			}
			let accum = chapters.get(c.chapterId);
			if (!accum) {
				accum = {
					chapterId: c.chapterId,
					chapterName: c.chapterName,
					values: new Array(dates.length).fill(0) as number[],
					totalInWindow: 0,
				};
				chapters.set(c.chapterId, accum);
			}
			accum.values[idx]! += c.count;
			accum.totalInWindow += c.count;
		}
	}

	const ranked = [...chapters.values()].sort((a, b) => b.totalInWindow - a.totalInWindow);
	const named = ranked.slice(0, DASHBOARD_TOP_N);
	const merged = ranked.slice(DASHBOARD_TOP_N);

	const bands: ChartBand[] = [];

	for (const c of named) {
		bands.push({
			key: String(c.chapterId),
			label: c.chapterName,
			values: c.values,
		});
	}

	if (nullHasAny) {
		bands.push({
			key: 'no-chapter',
			label: NO_CHAPTER_BAND_LABEL,
			values: nullValues,
		});
	}

	if (merged.length > 0) {
		const otherValues = new Array(dates.length).fill(0) as number[];
		for (const c of merged) {
			for (let i = 0; i < dates.length; i++) {
				otherValues[i]! += c.values[i]!;
			}
		}
		bands.push({
			key: 'other',
			label: OTHER_BAND_LABEL,
			values: otherValues,
			mergedChapters: merged.map((c) => ({
				chapterId: c.chapterId,
				chapterName: c.chapterName,
				values: c.values,
				totalInWindow: c.totalInWindow,
			})),
		});
	}

	// Always populate dailyTotals — for both Slack and Solidarity the per-band
	// sum can exceed the distinct daily total when a user belongs to multiple
	// chapters (Slack via slack_joins.chapter_ids; Solidarity via the snapshot's
	// distinct-total sentinel row). The overlay marker lets viewers see the
	// real total at a glance.
	const totalsByDate = new Map<string, number>();
	for (const d of days) totalsByDate.set(d.date, d.total);
	const dailyTotals = dates.map((d) => totalsByDate.get(d) ?? 0);

	return { dates, bands, dailyTotals };
}

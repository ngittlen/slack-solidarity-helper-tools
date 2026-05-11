import { describe, it, expect, vi } from 'vitest';
import { computeWindow, computeWeeklyLeaderboard } from './weekly-growth-report.js';

describe('computeWindow', () => {
	function expectWindow(input: string, expectedEnd: string, expectedStart: string) {
		const { start, end } = computeWindow(new Date(input));
		expect(end.toISOString()).toBe(expectedEnd);
		expect(start.toISOString()).toBe(expectedStart);
	}

	it('snaps to the same UTC Monday midnight regardless of which day-of-week now is', () => {
		// All of these dates land in the same Mon-to-Mon week:
		// 2026-05-04 (Mon) 00:00 UTC → 2026-05-11 (Mon) 00:00 UTC
		const expectedEnd = '2026-05-11T00:00:00.000Z';
		const expectedStart = '2026-05-04T00:00:00.000Z';

		// Cron firing Monday 14:00 UTC after the window closes
		expectWindow('2026-05-11T14:00:00Z', expectedEnd, expectedStart);
		// Mid-week dashboard view
		expectWindow('2026-05-13T10:00:00Z', expectedEnd, expectedStart);
		// Saturday afternoon
		expectWindow('2026-05-16T18:30:00Z', expectedEnd, expectedStart);
		// Sunday late evening — still maps to the Monday that *started* the week
		expectWindow('2026-05-17T23:59:00Z', expectedEnd, expectedStart);
	});

	it('rolls forward to the next Monday once the next Monday actually arrives', () => {
		// Monday 00:01 UTC of the *following* Monday is past the window's end,
		// so the window slides forward by exactly one week.
		expectWindow(
			'2026-05-18T00:01:00Z',
			'2026-05-18T00:00:00.000Z',
			'2026-05-11T00:00:00.000Z'
		);
	});
});

describe('computeWeeklyLeaderboard', () => {
	function makeDb(opts: {
		windows?: Array<{ windowEnd: string; windowStart: string; totalNewJoins: number }>;
		rows?: Array<{
			chapterId: number;
			chapterName: string;
			slackChannelId: string | null;
			newJoins: number;
			existing: number;
		}>;
	}) {
		const windows = opts.windows ?? [];
		const rows = opts.rows ?? [];
		// The function issues two `select()` chains: first for windows
		// (orderBy().limit()) returning windows, then for chapter rows
		// (where()) returning rows. Queue results in that order.
		const queue: unknown[][] = [windows, rows];
		const select = vi.fn(() => {
			const result = queue.shift() ?? [];
			const terminal = {
				then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r),
			};
			const limit = vi.fn(() => terminal);
			const orderBy = vi.fn(() => ({ limit, ...terminal }));
			const where = vi.fn(() => terminal);
			const from = vi.fn(() => ({ orderBy, where, limit, ...terminal }));
			return { from };
		});
		return { select } as unknown as Parameters<typeof computeWeeklyLeaderboard>[0];
	}

	it('reads the latest snapshot and reconstructs the leaderboard', async () => {
		const db = makeDb({
			windows: [
				{
					windowEnd: '2026-05-11T00:00:00.000Z',
					windowStart: '2026-05-04T00:00:00.000Z',
					totalNewJoins: 12,
				},
			],
			rows: [
				{ chapterId: 1, chapterName: '#sf', slackChannelId: 'C1', newJoins: 5, existing: 50 },
				{ chapterId: 2, chapterName: '#la', slackChannelId: null, newJoins: 2, existing: 200 },
			],
		});
		const result = await computeWeeklyLeaderboard(db);
		expect(result.windowEnd).toBe('2026-05-11T00:00:00.000Z');
		expect(result.windowStart).toBe('2026-05-04T00:00:00.000Z');
		expect(result.totalNewJoins).toBe(12);
		expect(result.chaptersWithGrowth).toBe(2);
		// chapter 1 has higher score: 5 / (50+1)^0.7 vs 2 / (200+1)^0.7
		expect(result.topChapters[0]?.chapterId).toBe(1);
		expect(result.topChapters[0]?.pct).toBeCloseTo(10, 5);
		expect(result.topChapters[1]?.chapterId).toBe(2);
	});

	it('filters excluded chapters', async () => {
		const db = makeDb({
			windows: [{ windowEnd: 'w', windowStart: 's', totalNewJoins: 7 }],
			rows: [
				{ chapterId: 1, chapterName: 'a', slackChannelId: null, newJoins: 5, existing: 50 },
				{ chapterId: 99, chapterName: 'excluded', slackChannelId: null, newJoins: 2, existing: 10 },
			],
		});
		const result = await computeWeeklyLeaderboard(db, {
			excludedChapterIds: new Set([99]),
		});
		expect(result.chaptersWithGrowth).toBe(1);
		expect(result.topChapters.map((c) => c.chapterId)).toEqual([1]);
	});

	it('prefers a fresh chapter channel mapping over the snapshotted one', async () => {
		const db = makeDb({
			windows: [{ windowEnd: 'w', windowStart: 's', totalNewJoins: 0 }],
			rows: [
				{ chapterId: 1, chapterName: 'a', slackChannelId: 'C_OLD', newJoins: 1, existing: 5 },
			],
		});
		const result = await computeWeeklyLeaderboard(db, {
			chapterChannelIds: new Map([[1, 'C_NEW']]),
		});
		expect(result.topChapters[0]?.slackChannelId).toBe('C_NEW');
	});

	it('returns an empty leaderboard when no snapshot exists', async () => {
		const db = makeDb({ windows: [], rows: [] });
		const result = await computeWeeklyLeaderboard(db);
		expect(result.chaptersWithGrowth).toBe(0);
		expect(result.totalNewJoins).toBe(0);
		expect(result.topChapters).toEqual([]);
	});
});
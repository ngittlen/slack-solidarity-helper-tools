import { describe, it, expect, vi } from 'vitest';
import { computeDoorsLeaderboardPair } from './door-knock-leaderboard.js';

// Wednesday 2026-07-15 → the campaign-local (Detroit) Monday is Jul 13, so
// this week is Jul 13 → Jul 20 and last week is Mon Jul 6 → Mon Jul 13; the
// ranking denominator week for lastWeek is Jun 29 → Jul 6.
const NOW = new Date('2026-07-15T12:00:00Z');

type Row = { date: string; chapter_name: string; doors: number; contacts: number };

function makeDb(rows: Row[]) {
	const all = vi.fn(async () => rows);
	return { db: { all } as never, all };
}

describe('computeDoorsLeaderboardPair', () => {
	it('buckets rows into the three Monday-pinned windows', async () => {
		const { db, all } = makeDb([
			{ date: '2026-07-01', chapter_name: 'Kent', doors: 100, contacts: 20 }, // week before
			{ date: '2026-07-08', chapter_name: 'Kent', doors: 200, contacts: 40 }, // last week
			{ date: '2026-07-12', chapter_name: 'Kent', doors: 50, contacts: 10 }, // last week (Sun)
			{ date: '2026-07-13', chapter_name: 'Kent', doors: 75, contacts: 15 }, // this week (Mon)
			{ date: '2026-07-14', chapter_name: 'Kent', doors: 25, contacts: 5 }, // this week
		]);

		const pair = await computeDoorsLeaderboardPair(db, { now: NOW });

		expect(pair.lastWeek.ok && pair.lastWeek.leaderboard.totalDoors).toBe(250);
		expect(pair.thisWeek.ok && pair.thisWeek.leaderboard.totalDoors).toBe(100);
		// Contact rate = window contacts / window doors: 50/250 and 20/100.
		expect(pair.lastWeek.ok && pair.lastWeek.leaderboard.contactRatePct).toBe(20);
		expect(pair.thisWeek.ok && pair.thisWeek.leaderboard.totalContacts).toBe(20);
		expect(pair.thisWeek.ok && pair.thisWeek.leaderboard.contactRatePct).toBe(20);
		expect(pair.lastWeek.ok && pair.lastWeek.leaderboard.windowStart).toBe(
			'2026-07-06T00:00:00.000Z',
		);
		expect(pair.thisWeek.ok && pair.thisWeek.leaderboard.windowEnd).toBe(
			'2026-07-20T00:00:00.000Z',
		);
		// One read spans all three windows.
		expect(JSON.stringify(all.mock.calls[0])).toContain('2026-06-29');
		expect(JSON.stringify(all.mock.calls[0])).toContain('2026-07-20');
	});

	it('pins the week to Detroit time so a Sunday-night ET run stays on the current week', async () => {
		// 2026-07-13T02:00Z is Sun 10 pm EDT — still Jul 12 in Detroit, but
		// already Mon Jul 13 in UTC. A UTC-pinned window jumps a week ahead to an
		// empty [Jul 13, Jul 20) "this week"; the campaign-local window must stay
		// on [Jul 6, Jul 13) and still show this week's doors.
		const sundayNight = new Date('2026-07-13T02:00:00Z');
		const { db } = makeDb([
			{ date: '2026-07-01', chapter_name: 'Kent', doors: 200, contacts: 40 }, // last week
			{ date: '2026-07-11', chapter_name: 'Kent', doors: 90, contacts: 18 }, // this week (Sat)
		]);

		const pair = await computeDoorsLeaderboardPair(db, { now: sundayNight });

		expect(pair.thisWeek.ok && pair.thisWeek.leaderboard.windowStart).toBe(
			'2026-07-06T00:00:00.000Z',
		);
		expect(pair.thisWeek.ok && pair.thisWeek.leaderboard.windowEnd).toBe(
			'2026-07-13T00:00:00.000Z',
		);
		expect(pair.thisWeek.ok && pair.thisWeek.leaderboard.totalDoors).toBe(90);
		expect(pair.lastWeek.ok && pair.lastWeek.leaderboard.totalDoors).toBe(200);
	});

	it('ranks by raw doors when no chapter has previous-week data', async () => {
		const { db } = makeDb([
			{ date: '2026-07-14', chapter_name: 'Small', doors: 40, contacts: 8 },
			{ date: '2026-07-14', chapter_name: 'Big', doors: 400, contacts: 80 },
			{ date: '2026-07-14', chapter_name: 'Mid', doors: 100, contacts: 20 },
		]);

		const pair = await computeDoorsLeaderboardPair(db, { now: NOW, rankingAlpha: 0.7 });

		if (!pair.thisWeek.ok) throw new Error('expected ok');
		expect(pair.thisWeek.leaderboard.topChapters.map((c) => c.chapterName)).toEqual([
			'Big',
			'Mid',
			'Small',
		]);
		expect(pair.thisWeek.leaderboard.topChapters[0]).toMatchObject({
			doors: 400,
			contacts: 80,
			prevDoors: 0,
			pct: 0,
		});
	});

	it('ranks chapters with no prior-week data below those that have it, even on higher raw volume', async () => {
		// "Newcomer" knocked the most doors this week but has no prior week, so its
		// score (400 / 1) would otherwise top the board. "Established" improved
		// 100 → 150 week-over-week. The established chapter must rank first; the
		// newcomer drops to the bottom despite its larger raw total.
		const { db } = makeDb([
			{ date: '2026-07-08', chapter_name: 'Established', doors: 100, contacts: 0 }, // last week
			{ date: '2026-07-14', chapter_name: 'Established', doors: 150, contacts: 0 }, // this week
			{ date: '2026-07-14', chapter_name: 'Newcomer', doors: 400, contacts: 0 }, // this week only
		]);

		const pair = await computeDoorsLeaderboardPair(db, { now: NOW, rankingAlpha: 0.7 });

		if (!pair.thisWeek.ok) throw new Error('expected ok');
		expect(pair.thisWeek.leaderboard.topChapters.map((c) => c.chapterName)).toEqual([
			'Established',
			'Newcomer',
		]);
		// The newcomer is still listed (below the established chapter), with no
		// prior-week comparison.
		expect(pair.thisWeek.leaderboard.topChapters[1]).toMatchObject({
			chapterName: 'Newcomer',
			doors: 400,
			prevDoors: 0,
			pct: 0,
		});
	});

	it('orders multiple prior-week-less chapters among themselves by raw doors, at the bottom', async () => {
		const { db } = makeDb([
			{ date: '2026-07-08', chapter_name: 'Established', doors: 50, contacts: 0 }, // last week
			{ date: '2026-07-14', chapter_name: 'Established', doors: 60, contacts: 0 }, // this week
			{ date: '2026-07-14', chapter_name: 'NewBig', doors: 300, contacts: 0 }, // this week only
			{ date: '2026-07-14', chapter_name: 'NewSmall', doors: 90, contacts: 0 }, // this week only
		]);

		const pair = await computeDoorsLeaderboardPair(db, { now: NOW, rankingAlpha: 0.7 });

		if (!pair.thisWeek.ok) throw new Error('expected ok');
		expect(pair.thisWeek.leaderboard.topChapters.map((c) => c.chapterName)).toEqual([
			'Established',
			'NewBig',
			'NewSmall',
		]);
	});

	it('weights by week-over-week improvement once previous-week data exists', async () => {
		// α = 1: Steady 100→100 scores 100/101 ≈ 0.99; Surging 10→60 scores
		// 60/11 ≈ 5.45 — Surging ranks first despite fewer doors.
		const { db } = makeDb([
			{ date: '2026-07-08', chapter_name: 'Steady', doors: 100, contacts: 0 },
			{ date: '2026-07-08', chapter_name: 'Surging', doors: 10, contacts: 0 },
			{ date: '2026-07-14', chapter_name: 'Steady', doors: 100, contacts: 0 },
			{ date: '2026-07-14', chapter_name: 'Surging', doors: 60, contacts: 0 },
		]);

		const pair = await computeDoorsLeaderboardPair(db, { now: NOW, rankingAlpha: 1 });

		if (!pair.thisWeek.ok) throw new Error('expected ok');
		expect(pair.thisWeek.leaderboard.topChapters.map((c) => c.chapterName)).toEqual([
			'Surging',
			'Steady',
		]);
		expect(pair.thisWeek.leaderboard.topChapters[0]).toMatchObject({
			doors: 60,
			prevDoors: 10,
			pct: 500,
		});
	});

	it("lastWeek ranks against the week before it and thisWeek against lastWeek", async () => {
		const { db } = makeDb([
			{ date: '2026-07-01', chapter_name: 'Kent', doors: 80, contacts: 0 }, // week before
			{ date: '2026-07-08', chapter_name: 'Kent', doors: 120, contacts: 0 }, // last week
			{ date: '2026-07-14', chapter_name: 'Kent', doors: 30, contacts: 0 }, // this week
		]);

		const pair = await computeDoorsLeaderboardPair(db, { now: NOW });

		if (!pair.lastWeek.ok || !pair.thisWeek.ok) throw new Error('expected ok');
		expect(pair.lastWeek.leaderboard.topChapters[0]).toMatchObject({
			doors: 120,
			prevDoors: 80,
			pct: 50,
		});
		expect(pair.thisWeek.leaderboard.topChapters[0]).toMatchObject({
			doors: 30,
			prevDoors: 120,
			pct: -75,
		});
	});

	it('caps topChapters at 5 but totals all chapters', async () => {
		const rows: Row[] = Array.from({ length: 7 }, (_, i) => ({
			date: '2026-07-14',
			chapter_name: `Chapter ${i + 1}`,
			doors: (i + 1) * 10,
			contacts: 0,
		}));
		const { db } = makeDb(rows);

		const pair = await computeDoorsLeaderboardPair(db, { now: NOW });

		if (!pair.thisWeek.ok) throw new Error('expected ok');
		expect(pair.thisWeek.leaderboard.topChapters).toHaveLength(5);
		expect(pair.thisWeek.leaderboard.topChapters[0]!.doors).toBe(70);
		expect(pair.thisWeek.leaderboard.totalDoors).toBe(10 + 20 + 30 + 40 + 50 + 60 + 70);
	});

	it('returns empty leaderboards when there are no rows', async () => {
		const { db } = makeDb([]);
		const pair = await computeDoorsLeaderboardPair(db, { now: NOW });
		if (!pair.thisWeek.ok || !pair.lastWeek.ok) throw new Error('expected ok');
		expect(pair.thisWeek.leaderboard.topChapters).toEqual([]);
		expect(pair.thisWeek.leaderboard.totalDoors).toBe(0);
		expect(pair.thisWeek.leaderboard.contactRatePct).toBe(0);
		expect(pair.lastWeek.leaderboard.topChapters).toEqual([]);
	});
});

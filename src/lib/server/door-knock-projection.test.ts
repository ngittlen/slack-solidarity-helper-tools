import { describe, it, expect } from 'vitest';
import {
	projectDoorsAtDeadline,
	loadDoorKnockDayTotals,
	PROJECTION_WINDOW_DAYS,
	type DoorKnockDayTotal,
} from './door-knock-projection.js';
import { vi } from 'vitest';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 9, 12); // 2026-07-09T12:00Z

function days(totals: number[]): DoorKnockDayTotal[] {
	return totals.map((total, i) => ({
		date: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10),
		total,
	}));
}

describe('projectDoorsAtDeadline', () => {
	it('adds the mean daily pace times the fractional remaining days', () => {
		// 100/day pace over 7 days, 2.5 days remaining → 700 + 250.
		const result = projectDoorsAtDeadline(days([100, 100, 100, 100, 100, 100, 100]), NOW + 2.5 * DAY, NOW);
		expect(result).toBe(950);
	});

	it('uses only the last PROJECTION_WINDOW_DAYS dates for the pace but all data for the base', () => {
		// 10 days: first three at 1000/day (old surge), last seven at 100/day.
		const totals = [1000, 1000, 1000, 100, 100, 100, 100, 100, 100, 100];
		const result = projectDoorsAtDeadline(days(totals), NOW + 1 * DAY, NOW);
		// Base 3700 + pace 100 × 1 day — the surge days count toward the total
		// but not the pace.
		expect(result).toBe(3800);
		expect(totals.length).toBeGreaterThan(PROJECTION_WINDOW_DAYS);
	});

	it('averages over however many days exist when fewer than the window', () => {
		// Two days at 80 and 120 → pace 100/day, 3 days left.
		expect(projectDoorsAtDeadline(days([80, 120]), NOW + 3 * DAY, NOW)).toBe(500);
	});

	it('counts zero-door days against the pace', () => {
		expect(projectDoorsAtDeadline(days([100, 0]), NOW + 2 * DAY, NOW)).toBe(200);
	});

	it('returns null with no data, a passed deadline, or an invalid deadline', () => {
		expect(projectDoorsAtDeadline([], NOW + DAY, NOW)).toBeNull();
		expect(projectDoorsAtDeadline(days([100]), NOW, NOW)).toBeNull();
		expect(projectDoorsAtDeadline(days([100]), NOW - DAY, NOW)).toBeNull();
		expect(projectDoorsAtDeadline(days([100]), NaN, NOW)).toBeNull();
	});
});

describe('loadDoorKnockDayTotals', () => {
	it('maps and numbers the grouped rows', async () => {
		const all = vi.fn(async () => [
			{ date: '2026-07-01', total: 140 },
			{ date: '2026-07-02', total: '175' },
		]);
		const rows = await loadDoorKnockDayTotals({ all } as never);
		expect(rows).toEqual([
			{ date: '2026-07-01', total: 140 },
			{ date: '2026-07-02', total: 175 },
		]);
		expect(JSON.stringify(all.mock.calls[0])).toContain('GROUP BY date');
	});
});

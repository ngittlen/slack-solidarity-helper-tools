import { describe, it, expect } from 'vitest';
import {
	DRIFT_ALERT_MAX_ROWS,
	needsDriftAlert,
	newDriftAlerts,
	renderDriftAlert,
	staleDriftStamps,
	type AlertableDrift,
} from './drift-alert.js';
import { driftAdvice, driftLabel, type DriftItem } from './turf-drift.js';

const APP = 'https://app.example.org';

function item(over: Partial<AlertableDrift> = {}): AlertableDrift {
	return {
		kind: 'claimed-not-in-minivan',
		turfId: 100,
		turfName: 'Turf 01',
		regionName: 'Ann Arbor',
		chapterId: 71,
		chapterName: 'Washtenaw County',
		campaignId: 1,
		doorCount: 250,
		heldBy: 'Dana',
		heldByUserId: 'U_DANA',
		hasListNumber: true,
		alertedKind: null,
		...over,
	};
}

describe('needsDriftAlert', () => {
	it('announces a turf the channel has never been told about', () => {
		expect(needsDriftAlert(item({ alertedKind: null }))).toBe(true);
	});

	it('stays quiet about drift already announced', () => {
		expect(needsDriftAlert(item({ alertedKind: 'claimed-not-in-minivan' }))).toBe(false);
	});
});

describe('newDriftAlerts', () => {
	it('keeps only unannounced rows, in the order given', () => {
		const fresh = newDriftAlerts([
			item({ turfId: 1, alertedKind: 'claimed-not-in-minivan' }),
			item({ turfId: 2 }),
			item({ turfId: 3, alertedKind: 'claimed-not-in-minivan' }),
			item({ turfId: 4 }),
		]);
		expect(fresh.map((i) => i.turfId)).toEqual([2, 4]);
	});

	it('returns nothing when every drifting turf has been announced', () => {
		expect(newDriftAlerts([item({ alertedKind: 'claimed-not-in-minivan' })])).toEqual([]);
	});
});

describe('staleDriftStamps', () => {
	it('clears a stamp for turf that stopped drifting', () => {
		expect(staleDriftStamps([100, 200], [item({ turfId: 100 })])).toEqual([200]);
	});

	it('keeps the stamp of a turf that is still drifting', () => {
		expect(staleDriftStamps([100], [item({ turfId: 100 })])).toEqual([]);
	});

	it('clears everything when nothing drifts any more', () => {
		expect(staleDriftStamps([100, 200, 300], [])).toEqual([100, 200, 300]);
	});
});

describe('renderDriftAlert', () => {
	// A Google volunteer chooses their own name, and this goes to a channel.
	it("escapes the holder's name so it cannot ping or link", () => {
		const text = renderDriftAlert(
			[item({ heldBy: '<!channel> <https://evil.example|re-auth> & co' })],
			APP,
		)!;
		expect(text).toContain(
			'held by &lt;!channel&gt; &lt;https://evil.example|re-auth&gt; &amp; co',
		);
		expect(text).not.toContain('<!channel>');
	});

	it('returns null for an empty list rather than a header with nothing under it', () => {
		expect(renderDriftAlert([], APP)).toBeNull();
	});

	it('leads with the count and links the report', () => {
		const text = renderDriftAlert([item(), item({ turfId: 200 })], APP)!;
		expect(text).toContain('2 new disagreements');
		expect(text).toContain(`<${APP}/turfs/organizer|Open the drift report>`);
	});

	it('says "disagreement" in the singular for one row', () => {
		expect(renderDriftAlert([item()], APP)!).toContain('1 new disagreement between');
	});

	// Dropped as drift (turf-drift.ts): VAN-held turf is already unclaimable.
	it('never announces turf for being in MiniVAN without a claim here', () => {
		const text = renderDriftAlert([item()], APP)!;
		expect(text).not.toContain('In MiniVAN, not claimed here');
		expect(text).not.toContain('claimed twice');
	});

	it('reuses the report wording, so the channel and the page cannot disagree', () => {
		const text = renderDriftAlert([item()], APP)!;
		expect(text).toContain(driftLabel('claimed-not-in-minivan'));
		expect(text).toContain(driftAdvice('claimed-not-in-minivan'));
	});

	it('names who holds it', () => {
		expect(renderDriftAlert([item({ heldBy: 'Dana' })], APP)!).toContain('held by Dana');
	});

	it('flags a drift row with no MiniVAN list number as an upstream fault', () => {
		// canClaim refuses turf without a list number, so a claimed row lacking one
		// means something went wrong before the checkout — worth naming inline.
		expect(renderDriftAlert([item({ hasListNumber: false })], APP)!).toContain(
			'no MiniVAN list number',
		);
		expect(renderDriftAlert([item({ hasListNumber: true })], APP)!).not.toContain(
			'no MiniVAN list number',
		);
	});

	it('falls back to the chapter name when a turf has no region', () => {
		expect(renderDriftAlert([item({ regionName: '' })], APP)!).toContain('Washtenaw County');
	});

	it('formats door counts with separators', () => {
		expect(renderDriftAlert([item({ doorCount: 1250 })], APP)!).toContain('1,250 doors');
	});

	// specs/012-multi-van-campaigns: the organizer needs to know whose VAN to
	// look in, once there is more than one.
	it('names the campaign of a row whose campaign shows a badge', () => {
		const text = renderDriftAlert([item({ campaignId: 2 }), item({ turfId: 200 })], APP, {
			badges: { 2: 'El-Sayed' },
		})!;
		expect(text).toContain('— El-Sayed · Ann Arbor ·');
		expect(text.match(/El-Sayed/g)).toHaveLength(1);
	});

	it('summarises past the row cap instead of posting hundreds of lines', () => {
		const many: DriftItem[] = Array.from({ length: DRIFT_ALERT_MAX_ROWS + 7 }, (_, i) =>
			item({ turfId: i + 1, turfName: `Turf ${i + 1}` }),
		);
		const text = renderDriftAlert(many, APP)!;
		expect(text).toContain(`${DRIFT_ALERT_MAX_ROWS + 7} new disagreements`);
		expect(text).toContain('+7 more');
		expect(text).toContain('Turf 10');
		expect(text).not.toContain('Turf 11');
	});
});

import { describe, it, expect } from 'vitest';
import { noticeLines, noticePushText, type NoticeLine } from './notice-text.js';
import { renderExpiryWarning } from './expiry-warning.js';
import { renderListNumberChanged } from './refresh-reconcile.js';
import { renderUnsyncedNudge } from './door-delta.js';

const APP = 'https://turf.example';

/** A line as plain text, for assertions that do not care about styling. */
const plain = (line: NoticeLine) => line.map((s) => s.text).join('');

describe('noticeLines', () => {
	// The real renderers, so a change to the DM wording that this cannot read
	// fails here rather than as stray asterisks on a volunteer's screen.
	it('reads the expiry warning as the DM says it', () => {
		const lines = noticeLines(
			renderExpiryWarning({
				turfName: 'Ypsi Turf 04',
				regionName: 'Ypsilanti',
				doorCount: 1234,
				chapterId: 71,
				expiresAt: '2026-10-04T22:00:00Z',
				hoursLeft: 6,
				appUrl: APP,
			}),
			APP,
		);

		expect(lines[0]).toEqual([{ text: 'Your turf expires in about 6 hours.', bold: true }]);
		expect(lines[1]).toEqual([]);
		expect(lines[2]).toEqual([
			{ text: 'Ypsi Turf 04', bold: true },
			{ text: ' — Ypsilanti · 1,234 doors' },
		]);
		const link = lines.flat().find((s) => s.href);
		expect(link).toEqual({ text: 'Open turf checkout', href: '/turfs?chapter=71' });
		// No mrkdwn survives anywhere.
		for (const line of lines) expect(plain(line)).not.toMatch(/[*<>]|:[a-z_]+:/);
	});

	it('keeps the new list number, which is the whole point of that message', () => {
		const lines = noticeLines(
			renderListNumberChanged({
				turf: {
					turfId: 1,
					mapRegionId: 2,
					chapterId: 71,
					name: 'Turf 01',
					regionName: '',
					printedListNumber: 'L-NEW',
					doorCount: 40,
					retiredAt: null,
				},
				listNumber: 'L-NEW',
				appUrl: APP,
			}),
			APP,
		);
		expect(lines.map(plain)).toContain('New list number: L-NEW');
	});

	it('reads the sync nudge, inline bold and trailing link included', () => {
		const lines = noticeLines(
			renderUnsyncedNudge({ turfName: 'Turf 01', regionName: '', chapterId: 3, appUrl: APP }),
			APP,
		);
		expect(lines.flat()).toContainEqual({ text: 'Sync', bold: true });
		expect(lines.flat()).toContainEqual({ text: 'Open turf checkout', href: '/turfs?chapter=3' });
	});

	it('keeps a link’s fragment, which opens one mentor walk', () => {
		expect(noticeLines(`Join on <${APP}/turfs?chapter=71#walk-12|/turfs>.`, APP)).toEqual([
			[{ text: 'Join on ' }, { text: '/turfs', href: '/turfs?chapter=71#walk-12' }, { text: '.' }],
		]);
	});

	it('shows a link to anywhere else as its label only', () => {
		expect(noticeLines('See <https://evil.example/x|this page>.', APP)).toEqual([
			[{ text: 'See ' }, { text: 'this page' }, { text: '.' }],
		]);
		expect(noticeLines('<javascript:alert(1)|click>', APP)).toEqual([[{ text: 'click' }]]);
		// Same origin on paper, but `//evil.example` is a link to another site.
		expect(noticeLines(`<${APP}//evil.example/x|here>`, APP)).toEqual([[{ text: 'here' }]]);
	});

	it("undoes Slack's escapes, leaving the text as text", () => {
		expect(noticeLines('*A &amp; B &lt;North&gt;*', APP)).toEqual([
			[{ text: 'A & B <North>', bold: true }],
		]);
	});

	it('collapses blank runs and trims them from both ends', () => {
		expect(noticeLines(':warning: one\n\n\n\ntwo\n\n', APP)).toEqual([
			[{ text: 'one' }],
			[],
			[{ text: 'two' }],
		]);
	});
});

describe('noticePushText', () => {
	const APP = 'https://app.example';

	it('is the same words as plain text, opening the first link into the app', () => {
		const text =
			':hourglass_flowing_sand: *Your turf expires in about 6 hours.*\n\n' +
			'*Kent 03*  · 40 doors\n' +
			'<https://app.example/turfs?chapter=4|Open turf checkout>';
		expect(noticePushText(text, APP)).toEqual({
			body: 'Your turf expires in about 6 hours.\nKent 03  · 40 doors\nOpen turf checkout',
			url: '/turfs?chapter=4',
		});
	});

	it('opens /turfs when the notice links nowhere in the app', () => {
		expect(noticePushText('<https://elsewhere.example/x|Look>', APP).url).toBe('/turfs');
	});

	it('cuts a long notice short', () => {
		const { body } = noticePushText('word '.repeat(200), APP, 50);
		expect(body).toHaveLength(50);
		expect(body.endsWith('…')).toBe(true);
	});
});

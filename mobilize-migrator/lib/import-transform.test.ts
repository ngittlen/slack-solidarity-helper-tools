import { describe, expect, it } from 'vitest';

import {
	descriptionToHtml,
	formatAddress,
	hasMobilizeTag,
	MOBILIZE_IMPORT_TAG,
	pageContent,
	planImport,
	type PlanImportOptions,
} from './import-transform.js';
import type { MobilizeEvent } from './mobilize.js';
import { MOBILIZE_EXCLUDE_TAG } from './solidarity.js';

const NOW = 1_800_000_000;
const PARTNER_ORG = 42;
const HOUR = 3600;

function event(overrides: Partial<MobilizeEvent> = {}): MobilizeEvent {
	return {
		id: 501,
		title: 'Canvass with the partner campaign',
		event_type: 'CANVASS',
		browser_url: 'https://www.mobilize.us/partner/event/501/',
		visibility: 'PUBLIC',
		description: 'Join us.\n\nBring water.',
		featured_image_url: 'https://cdn.mobilize.us/image.png',
		tags: [{ id: 9, name: 'Shared Shift' }],
		sponsor: { id: PARTNER_ORG, name: 'Partner Campaign' },
		address_visibility: 'PUBLIC',
		is_virtual: false,
		virtual_action_url: null,
		timeslots: [
			{ id: 2, start_date: NOW + 48 * HOUR, end_date: NOW + 50 * HOUR },
			{ id: 1, start_date: NOW + 24 * HOUR, end_date: NOW + 26 * HOUR },
		],
		location: {
			venue: 'Union Hall',
			address_lines: ['123 Main St', ''],
			locality: 'Flint',
			region: 'MI',
			postal_code: '48502',
			location: { latitude: 43.01, longitude: -83.69 },
		},
		...overrides,
	};
}

const options: PlanImportOptions = {
	tagName: 'shared shift',
	sourceOrgId: PARTNER_ORG,
	now: NOW,
	zipChapters: new Map([['48502', 77]]),
	defaultChapterId: 1,
};

describe('hasMobilizeTag', () => {
	it('matches ignoring case and surrounding space', () => {
		expect(hasMobilizeTag(event(), '  SHARED shift ')).toBe(true);
	});

	it('is false for a different tag, no tags, or a blank setting', () => {
		expect(hasMobilizeTag(event(), 'other')).toBe(false);
		expect(hasMobilizeTag(event({ tags: null }), 'shared shift')).toBe(false);
		expect(hasMobilizeTag(event(), '  ')).toBe(false);
	});
});

describe('descriptionToHtml', () => {
	it('turns plain text into escaped paragraphs', () => {
		expect(descriptionToHtml('Line one\nline two\n\nA & B <3')).toBe(
			'<p>Line one<br>line two</p>\n<p>A &amp; B &lt;3</p>',
		);
	});

	it('passes HTML through untouched', () => {
		expect(descriptionToHtml('<p>Already <b>formatted</b></p>')).toBe(
			'<p>Already <b>formatted</b></p>',
		);
	});

	it('is empty for no description', () => {
		expect(descriptionToHtml(null)).toBe('');
	});
});

describe('pageContent', () => {
	it('credits and links the original', () => {
		const html = pageContent({ description: 'Hi', browser_url: 'https://m.us/e/1' });
		expect(html).toBe(
			'<p>Hi</p>\n<p><em>Originally posted on <a href="https://m.us/e/1">Mobilize</a>.</em></p>',
		);
	});

	it('still has content with no description or link — the endpoint requires it', () => {
		expect(pageContent({ description: '', browser_url: undefined })).toBe(
			'<p>Details to come.</p>',
		);
	});

	it('fits within Solidarity’s 100,000-character cap', () => {
		const html = pageContent({ description: 'x'.repeat(200_000), browser_url: 'https://m.us/e/1' });
		expect(html.length).toBeLessThanOrEqual(100_000);
		expect(html).toContain('Originally posted on');
	});

	it('never leaves a tag cut in half where it trims', () => {
		const tag = '<a href="https://example.org/a/fairly/long/path">';
		// Slide the tag across the cut point, so some lengths cut inside it.
		for (let pad = 99_650; pad < 99_850; pad += 3) {
			const html = pageContent(
				{ description: `${'x'.repeat(pad)}${tag}link</a>`, browser_url: 'https://m.us/e/1' },
				{ privateAddress: true },
			);
			const body = html.slice(0, html.indexOf('\n<p><strong>'));
			expect(html.length).toBeLessThanOrEqual(100_000);
			expect(body).not.toMatch(/<[^>]*$/);
			expect(html).toContain("This event's address is private.");
		}
	});

	it('sends people to Mobilize for a private address', () => {
		const html = pageContent(
			{ description: 'Hi', browser_url: 'https://m.us/e/1' },
			{ privateAddress: true },
		);
		expect(html).toContain(
			"<p><strong>This event's address is private.</strong> To see it, " +
				'<a href="https://m.us/e/1">register for the event on Mobilize</a>.</p>',
		);
		expect(html.indexOf('address is private')).toBeLessThan(html.indexOf('Originally posted'));
	});

	it('sends people to Mobilize for a virtual event’s join link', () => {
		const html = pageContent(
			{ description: 'Hi', browser_url: 'https://m.us/e/1' },
			{ virtualWithoutLink: true },
		);
		expect(html).toContain('To get the link to join, <a href="https://m.us/e/1">');
	});

	it('links nothing that is not https', () => {
		const html = pageContent(
			{ description: 'Hi', browser_url: 'javascript:alert(1)' },
			{ privateAddress: true },
		);
		expect(html).not.toContain('javascript:');
		expect(html).not.toContain('<a ');
		expect(html).toContain("This event's address is private.");
	});
});

describe('formatAddress', () => {
	it('joins the parts Mobilize has, skipping blanks', () => {
		expect(formatAddress(event().location)).toBe('123 Main St, Flint, MI 48502');
	});

	it('is null with no location', () => {
		expect(formatAddress(null)).toBeNull();
	});

	it('leaves out the street when asked', () => {
		expect(formatAddress(event().location, false)).toBe('Flint, MI 48502');
	});
});

describe('planImport', () => {
	it('maps an in-person event, earliest timeslot first', () => {
		const { planned, skipped } = planImport([event()], options);
		expect(skipped).toEqual([]);
		expect(planned).toHaveLength(1);
		const [plan] = planned;
		expect(plan.timeslots.map((t) => t.mobilizeTimeslotId)).toEqual([1, 2]);
		expect(plan.event).toEqual({
			title: 'Canvass with the partner campaign',
			event_type: 'in_person',
			start_time: NOW + 24 * HOUR,
			end_time: NOW + 26 * HOUR,
			scope_id: 77,
			scope_type: 'Chapter',
			location_name: 'Union Hall',
			location_address: '123 Main St, Flint, MI 48502',
			virtual_url: null,
			latitude: 43.01,
			longitude: -83.69,
			tags: [MOBILIZE_EXCLUDE_TAG, MOBILIZE_IMPORT_TAG],
			allow_long_title: true,
		});
		expect(plan.page.image_url).toBe('https://cdn.mobilize.us/image.png');
		expect(plan.usedFallbackScope).toBe(false);
	});

	// Without it, the outbound sync would push the import into our own org.
	it('always tags imports mobilize-exclude', () => {
		const [plan] = planImport([event({ is_virtual: true })], options).planned;
		expect(plan.event.tags).toContain(MOBILIZE_EXCLUDE_TAG);
	});

	it('files an in-person event with an unmapped zip under the default chapter, flagged', () => {
		const [plan] = planImport(
			[event({ location: { ...event().location!, postal_code: '90210' } })],
			options,
		).planned;
		expect(plan.event.scope_id).toBe(1);
		expect(plan.usedFallbackScope).toBe(true);
	});

	it('files a virtual event under the default chapter without flagging it', () => {
		const [plan] = planImport(
			[
				event({
					is_virtual: true,
					location: null,
					virtual_action_url: 'https://zoom.us/j/1',
				}),
			],
			options,
		).planned;
		expect(plan.event).toMatchObject({
			event_type: 'virtual',
			scope_id: 1,
			virtual_url: 'https://zoom.us/j/1',
			location_name: null,
			location_address: null,
		});
		expect(plan.usedFallbackScope).toBe(false);
	});

	it('skips untagged, promoted, non-public, and past-only events', () => {
		const { planned, skipped } = planImport(
			[
				event({ id: 1, tags: [] }),
				event({ id: 2, visibility: 'PRIVATE' }),
				event({ id: 3, visibility: undefined }),
				event({ id: 4, timeslots: [{ id: 9, start_date: NOW - HOUR, end_date: NOW }] }),
				// Promoted by the partner but owned by another org — maybe ours.
				event({ id: 5, sponsor: { id: 7 } }),
				event({ id: 6, sponsor: undefined }),
			],
			options,
		);
		expect(planned).toEqual([]);
		expect(skipped.map((s) => [s.mobilizeEventId, s.reason])).toEqual([
			[1, 'not-tagged'],
			[2, 'not-public'],
			[3, 'not-public'],
			[4, 'no-upcoming-timeslots'],
			[5, 'not-owned'],
			[6, 'not-owned'],
		]);
	});

	it('publishes only city, state and zip for a private address, and says where to look', () => {
		const [plan] = planImport([event({ address_visibility: 'PRIVATE' })], options).planned;
		expect(plan.event).toMatchObject({
			location_name: null,
			location_address: 'Flint, MI 48502',
			latitude: null,
			longitude: null,
			// The zip is kept, so the chapter still comes from it.
			scope_id: 77,
		});
		expect(plan.page.content).toContain("This event's address is private.");
		expect(plan.page.content).not.toContain('123 Main St');
		expect(plan.page.content).not.toContain('Union Hall');
	});

	it('adds the join-link note to a virtual event without a link, and not to one with', () => {
		const [noLink, withLink] = planImport(
			[
				event({ id: 1, is_virtual: true, location: null, virtual_action_url: null }),
				event({
					id: 2,
					is_virtual: true,
					location: null,
					virtual_action_url: 'https://zoom.us/j/1',
				}),
			],
			options,
		).planned;
		expect(noLink.page.content).toContain('To get the link to join');
		expect(withLink.page.content).not.toContain('To get the link to join');
	});

	it('refuses a virtual URL that is not https', () => {
		const [plan] = planImport(
			[event({ is_virtual: true, location: null, virtual_action_url: 'javascript:alert(1)' })],
			options,
		).planned;
		expect(plan.event.virtual_url).toBeNull();
		expect(plan.page.content).toContain('To get the link to join');
	});

	it('drops past timeslots and keeps the upcoming ones', () => {
		const [plan] = planImport(
			[
				event({
					timeslots: [
						{ id: 1, start_date: NOW - HOUR, end_date: NOW },
						{ id: 2, start_date: NOW + HOUR, end_date: NOW + 2 * HOUR },
					],
				}),
			],
			options,
		).planned;
		expect(plan.timeslots.map((t) => t.mobilizeTimeslotId)).toEqual([2]);
		expect(plan.event.start_time).toBe(NOW + HOUR);
	});

	it('leaves out shifts the partner has closed', () => {
		const [plan] = planImport(
			[
				event({
					timeslots: [
						{ id: 1, start_date: NOW + HOUR, end_date: NOW + 2 * HOUR, is_full: true },
						{ id: 2, start_date: NOW + 3 * HOUR, end_date: NOW + 4 * HOUR, is_full: false },
						{ id: 3, start_date: NOW + 5 * HOUR, end_date: NOW + 6 * HOUR },
					],
				}),
			],
			options,
		).planned;
		expect(plan.timeslots.map((t) => t.mobilizeTimeslotId)).toEqual([2, 3]);
		expect(plan.event.start_time).toBe(NOW + 3 * HOUR);
	});

	it('skips an event whose every upcoming shift is full', () => {
		const { planned, skipped } = planImport(
			[
				event({
					timeslots: [
						{ id: 1, start_date: NOW - HOUR, end_date: NOW },
						{ id: 2, start_date: NOW + HOUR, end_date: NOW + 2 * HOUR, is_full: true },
					],
				}),
			],
			options,
		);
		expect(planned).toEqual([]);
		expect(skipped).toEqual([
			{
				mobilizeEventId: 501,
				title: 'Canvass with the partner campaign',
				reason: 'all-shifts-full',
			},
		]);
	});

	it('leaves out an image that is not https', () => {
		const [plan] = planImport(
			[event({ featured_image_url: 'http://cdn.example/x.png' })],
			options,
		).planned;
		expect(plan.page.image_url).toBeNull();
	});
});

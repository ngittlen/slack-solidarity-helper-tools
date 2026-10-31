// Partner-org Mobilize event -> what the import creates in Solidarity.
//
// Pure: no network, no clock, no database. The caller hands in "now" and the
// zip -> chapter map, so every decision here is a unit test away.
//
// The import copies events a partner campaign has tagged in THEIR Mobilize org
// into our Solidarity, as ordinary events with an event page. It is the mirror
// image of transform.ts, which plans our Solidarity events out to our own
// Mobilize org — and the two must never chase each other, which is why every
// imported event carries MOBILIZE_EXCLUDE_TAG.

import type { MobilizeEvent } from './mobilize.js';
import { normalizeZipKey } from './people.js';
import { MOBILIZE_EXCLUDE_TAG } from './solidarity.js';
import type { NewEventPage, NewSolidarityEvent } from './solidarity-events.js';

/** Marks an event as copied from a partner org, so organizers can find (and
 *  filter out) imports in the Solidarity dashboard. */
export const MOBILIZE_IMPORT_TAG = 'mobilize-import';

/** Solidarity's cap with `allow_long_title`. */
const MAX_TITLE_LENGTH = 200;
/** Solidarity's cap on page content. */
const MAX_PAGE_CONTENT_LENGTH = 100_000;

export interface PlannedTimeslot {
	mobilizeTimeslotId: number;
	startTime: number;
	endTime: number;
}

export interface PlannedImport {
	mobilizeEventId: number;
	title: string;
	browserUrl: string | null;
	/** Event-create payload; its times are `timeslots[0]`'s. */
	event: NewSolidarityEvent;
	/** Upcoming timeslots, earliest first. The first rides on the event create;
	 *  each of the rest becomes its own session. */
	timeslots: PlannedTimeslot[];
	page: NewEventPage;
	/**
	 * An in-person event whose zip matched no chapter, filed under the default
	 * chapter instead. Reported so someone can move it. Never set for a virtual
	 * event: those have no zip and belong in the default chapter by design.
	 */
	usedFallbackScope: boolean;
}

export type ImportSkipReason =
	'not-tagged' | 'not-owned' | 'not-public' | 'no-upcoming-timeslots' | 'all-shifts-full';

export interface SkippedImport {
	mobilizeEventId: number;
	title: string;
	reason: ImportSkipReason;
}

export interface ImportPlan {
	planned: PlannedImport[];
	skipped: SkippedImport[];
}

/** Case- and whitespace-insensitive: the tag is typed by a human in /settings
 *  and by another human in Mobilize. */
export function hasMobilizeTag(event: Pick<MobilizeEvent, 'tags'>, tagName: string): boolean {
	const wanted = tagName.trim().toLowerCase();
	if (!wanted) return false;
	return (event.tags ?? []).some((t) => (t.name ?? '').trim().toLowerCase() === wanted);
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Mobilize documents `description` as HTML, but most descriptions in practice
 * are plain text with blank lines between paragraphs. Sent as-is, those would
 * collapse into one run-on paragraph on the page, so text without any tags is
 * escaped and broken into paragraphs.
 */
export function descriptionToHtml(description: string | null | undefined): string {
	const text = (description ?? '').trim();
	if (!text) return '';
	if (/<[a-z][^>]*>/i.test(text)) return text;
	return text
		.split(/\n\s*\n/)
		.map((para) => para.trim())
		.filter(Boolean)
		.map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
		.join('\n');
}

/** A link we are willing to publish: https only, so nothing like a
 *  `javascript:` URL can ride in on partner data. */
function httpsOrNull(url: string | null | undefined): string | null {
	return url?.startsWith('https://') ? url : null;
}

export interface PageNotes {
	/** The partner hid the street address until registration; we leave it
	 *  out, so the page has to say where to find it. */
	privateAddress?: boolean;
	/** A virtual event whose join link Mobilize only sends to people who
	 *  register there — an RSVP in Solidarity never receives it. */
	virtualWithoutLink?: boolean;
}

/**
 * The page body: the partner's description, then any notes sending people to
 * the original for what we couldn't copy, then a credit line linking it.
 * Trimmed to fit Solidarity's cap if it must be.
 */
export function pageContent(
	event: Pick<MobilizeEvent, 'description' | 'browser_url'>,
	notes: PageNotes = {},
): string {
	const url = httpsOrNull(event.browser_url);
	const link = (text: string) => (url ? `<a href="${escapeHtml(url)}">${text}</a>` : text);
	const footer: string[] = [];
	if (notes.privateAddress) {
		footer.push(
			`<p><strong>This event's address is private.</strong> To see it, ` +
				`${link('register for the event on Mobilize')}.</p>`,
		);
	}
	if (notes.virtualWithoutLink) {
		footer.push(
			`<p><strong>This is a virtual event.</strong> To get the link to join, ` +
				`${link('register for the event on Mobilize')}.</p>`,
		);
	}
	if (url) footer.push(`<p><em>Originally posted on ${link('Mobilize')}.</em></p>`);
	const tail = footer.join('\n');

	let body = descriptionToHtml(event.description);
	const room = MAX_PAGE_CONTENT_LENGTH - tail.length - 1;
	// Cut, then drop a tag the cut left half-written: an unclosed `<a href="`
	// would otherwise swallow the notes after it.
	if (body.length > room) body = body.slice(0, room).replace(/<[^>]*$/, '');
	// The endpoint requires content, so an event with no description still
	// gets a page that says where it came from.
	return [body, tail].filter(Boolean).join('\n') || '<p>Details to come.</p>';
}

/** "123 Main St, Suite 4, Flint, MI 48502" — whatever parts Mobilize has.
 *  `includeStreet: false` gives just "Flint, MI 48502", for a private address. */
export function formatAddress(
	location: MobilizeEvent['location'],
	includeStreet = true,
): string | null {
	if (!location) return null;
	const street = includeStreet
		? (location.address_lines ?? []).map((l) => l?.trim()).filter(Boolean)
		: [];
	const stateZip = [location.region, location.postal_code]
		.map((p) => p?.trim())
		.filter(Boolean)
		.join(' ');
	const parts = [...street, location.locality?.trim(), stateZip].filter(Boolean);
	return parts.length > 0 ? parts.join(', ') : null;
}

export interface ImportScopeOptions {
	/** zip (five digits) -> Solidarity chapter id. */
	zipChapters: ReadonlyMap<string, number>;
	defaultChapterId: number;
}

/** Which chapter an event belongs to, and whether that was a fallback worth
 *  reporting. */
export function scopeFor(
	event: Pick<MobilizeEvent, 'is_virtual' | 'location'>,
	options: ImportScopeOptions,
): { chapterId: number; usedFallback: boolean } {
	if (event.is_virtual) return { chapterId: options.defaultChapterId, usedFallback: false };
	const zip = normalizeZipKey(event.location?.postal_code);
	const chapterId = zip ? options.zipChapters.get(zip) : undefined;
	return chapterId !== undefined
		? { chapterId, usedFallback: false }
		: { chapterId: options.defaultChapterId, usedFallback: true };
}

export interface PlanImportOptions extends ImportScopeOptions {
	/** The tag name from /settings. */
	tagName: string;
	/** The partner org's id: only events it owns are imported. */
	sourceOrgId: number;
	/** Unix seconds. */
	now: number;
}

export function planImport(events: MobilizeEvent[], options: PlanImportOptions): ImportPlan {
	const planned: PlannedImport[] = [];
	const skipped: SkippedImport[] = [];

	for (const event of events) {
		const skip = (reason: ImportSkipReason) =>
			skipped.push({ mobilizeEventId: event.id, title: event.title, reason });

		if (!hasMobilizeTag(event, options.tagName)) {
			skip('not-tagged');
			continue;
		}
		// The org's event list also returns events it promotes for other orgs —
		// possibly even ours, which began as our own Solidarity events. Only the
		// partner's own events are theirs to hand us. A missing sponsor is read
		// as "not theirs", for the same reason as a missing visibility below.
		if (event.sponsor?.id !== options.sourceOrgId) {
			skip('not-owned');
			continue;
		}
		// The Solidarity page is public, so an event the partner kept private
		// or unlisted would be published by copying it. Absent visibility is
		// treated as not public: the API always sends it, so absence means
		// something unexpected, and the safe reading of that is "don't publish".
		if (event.visibility !== 'PUBLIC') {
			skip('not-public');
			continue;
		}
		const upcoming = event.timeslots.filter((t) => t.start_date >= options.now);
		if (upcoming.length === 0) {
			skip('no-upcoming-timeslots');
			continue;
		}
		// A shift the partner has closed would arrive as an open session with no
		// cap — Mobilize doesn't return its caps — and volunteers would sign up
		// for it here. Create-only can't close it later, so it's left out now.
		const timeslots = upcoming
			.filter((t) => t.is_full !== true)
			.sort((a, b) => a.start_date - b.start_date)
			.map((t) => ({ mobilizeTimeslotId: t.id, startTime: t.start_date, endTime: t.end_date }));
		if (timeslots.length === 0) {
			skip('all-shifts-full');
			continue;
		}

		const isVirtual = event.is_virtual === true;
		const { chapterId, usedFallback } = scopeFor(event, options);
		// A hidden address may still reach us whole — we call with the
		// partner's own key — so it is cut down to city, state and zip here
		// rather than trusted to come back redacted. The venue name goes too: it
		// can be "Jane's house". The zip stays, so chapter matching still works.
		const privateAddress = !isVirtual && event.address_visibility === 'PRIVATE';
		const coordinates = privateAddress ? null : event.location?.location;
		const virtualUrl = isVirtual ? httpsOrNull(event.virtual_action_url) : null;
		const title = event.title.trim().slice(0, MAX_TITLE_LENGTH);
		const image = httpsOrNull(event.featured_image_url);

		planned.push({
			mobilizeEventId: event.id,
			title,
			browserUrl: event.browser_url ?? null,
			event: {
				title,
				event_type: isVirtual ? 'virtual' : 'in_person',
				start_time: timeslots[0].startTime,
				end_time: timeslots[0].endTime,
				scope_id: chapterId,
				scope_type: 'Chapter',
				location_name: isVirtual || privateAddress ? null : event.location?.venue?.trim() || null,
				location_address: isVirtual ? null : formatAddress(event.location, !privateAddress),
				virtual_url: virtualUrl,
				latitude: isVirtual ? null : (coordinates?.latitude ?? null),
				longitude: isVirtual ? null : (coordinates?.longitude ?? null),
				// MOBILIZE_EXCLUDE_TAG is load-bearing: without it the outbound
				// sync would copy this event into OUR Mobilize org.
				tags: [MOBILIZE_EXCLUDE_TAG, MOBILIZE_IMPORT_TAG],
				allow_long_title: true,
			},
			timeslots,
			page: {
				content: pageContent(event, {
					privateAddress,
					virtualWithoutLink: isVirtual && !virtualUrl,
				}),
				image_url: image,
			},
			usedFallbackScope: usedFallback,
		});
	}

	return { planned, skipped };
}

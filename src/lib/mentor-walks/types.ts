// What the mentor-walks screens are given (specs/015-mentor-walks), built by
// the pages' loads from the database.

import type { MentorWalksVisibility } from './rules.js';

/** What the walk form edits. `date` and `time` are campaign-local input
 *  values (`YYYY-MM-DD`, `HH:MM`). */
export interface WalkDraft {
	/** Absent when the form shows no chapter picker. */
	chapterId?: number;
	date: string;
	time: string;
	place: string;
	/** Where `place` was found on the map, as the mentor checked it. Null
	 *  until it has been looked up, and again whenever the place is edited. */
	point?: { lat: number; lng: number } | null;
	note: string;
	seats: number;
	phone: string;
}

/** Where the geocoder put a meeting place, to show the mentor before they
 *  post. */
export interface PlaceLocation {
	point: { lat: number; lng: number };
	/** The address the geocoder took it to mean, when it says. */
	matchedAddress: string | null;
}

/** What looking a place up came to, for the walk form. */
export type PlaceLookupResult =
	{ ok: true; location: PlaceLocation } | { ok: false; message: string };

/** One of a mentor's upcoming walks, as their list shows it. */
export interface MyWalkItem {
	id: string;
	dayLabel: string;
	timeLabel: string;
	place: string;
	seats: number;
	/** Names of the people holding seats. */
	joined: string[];
}

/** A mentor's upcoming walk on /turfs: the list item, and the form's values
 *  for editing it. */
export interface MentorWalkView extends MyWalkItem {
	/** Its chapter's name, which may be one /turfs no longer offers. */
	chapterName: string;
	draft: WalkDraft;
}

export interface ChapterOption {
	chapterId: number;
	name: string;
}

/** The mentor area of /turfs, or null for nothing at all. A mentor asked to
 *  agree again ('agree') still gets their walks: they can see and cancel
 *  them, and are asked to agree when they host or edit one (US2, scenario 7). */
export type MentorPanelView =
	| { state: 'invite' | 'declined'; guidelinesUrl: string }
	| {
			state: 'mentor' | 'agree';
			guidelinesUrl: string;
			walks: MentorWalkView[];
			walksHosted: number;
			newPeopleTakenOut: number;
			/** FR-012: from their latest walk that still has one. */
			defaultPhone: string;
			/** Chapters a walk can be posted in: the ones /turfs offers. */
			chapters: ChapterOption[];
	  };

/** An upcoming walk in the organizer view. */
export interface OrganizerWalkView {
	id: string;
	mentorName: string;
	chapterName: string;
	dayLabel: string;
	timeLabel: string;
	place: string;
	seats: number;
	joined: string[];
	status: 'scheduled' | 'cancelled' | 'hidden';
	/** Who cancelled or hid it, when someone did. */
	statusByName?: string | null;
}

/** A past walk in the organizer view. Null counts are not tracked yet. */
export interface OrganizerPastWalkView {
	id: string;
	mentorName: string;
	chapterName: string;
	dayLabel: string;
	place: string;
	seats: number;
	taken: number | null;
	attended: number | null;
	noShowReports: number;
	status?: 'scheduled' | 'cancelled' | 'hidden';
}

/** A mentor, current or revoked, in the organizer view. */
export interface OrganizerMentorView {
	id: string;
	name: string;
	/** Where they hosted last, when they have. */
	chapterName: string | null;
	status: 'active' | 'revoked';
	/** How they became a mentor. */
	source: 'invited' | 'organizer';
	agreedLabel: string | null;
	walksHosted: number;
	newPeopleTakenOut: number;
	/** "appointed by Alex", "revoked by Alex on Oct 3". */
	detail?: string;
}

/** Someone an organizer can make a mentor. */
export interface PersonOption {
	id: string;
	name: string;
}

/** What the admin-only debug panel on /turfs shows about the viewer. */
export interface MentorDebugView {
	/** This session counts as eligible and sees the feature whatever the
	 *  setting. */
	simulating: boolean;
	/** Their mentor status, or 'not invited'. */
	status: string;
	visibility: MentorWalksVisibility;
	guidelinesSet: boolean;
	completed: number;
	doors: number;
}

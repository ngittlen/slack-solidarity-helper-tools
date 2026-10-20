// The rules of mentor walks (specs/015-mentor-walks) that need no database:
// who sees the feature, which mentor screen someone gets, and what makes a
// walk valid. Shared by /turfs, the organizer view and the settings endpoint.

import { CAMPAIGN_TIME_ZONE, campaignDayKey, campaignWallClockToUtc } from '../campaign-time.js';

/** FR-040. 'staff' is "Admins and moderators only". */
export const MENTOR_WALKS_VISIBILITIES = ['off', 'staff', 'everyone'] as const;
export type MentorWalksVisibility = (typeof MENTOR_WALKS_VISIBILITIES)[number];

export const MENTOR_WALKS_VISIBILITY_LABELS: Record<MentorWalksVisibility, string> = {
	off: 'Off',
	staff: 'Admins and moderators only',
	everyone: 'Everyone',
};

/** NULL, '' or anything unknown is Off: the feature ships dark. */
export function parseVisibility(raw: string | null | undefined): MentorWalksVisibility {
	return (MENTOR_WALKS_VISIBILITIES as readonly string[]).includes(raw ?? '')
		? (raw as MentorWalksVisibility)
		: 'off';
}

/** FR-002: at least this many completed checkouts… */
export const MENTOR_MIN_COMPLETED = 4;
/** …or strictly more than this many doors. */
export const MENTOR_MIN_DOORS = 100;
/** "Not now" brings the invitation back after this long (FR-004). */
export const SNOOZE_DAYS = 7;
/** How long a walk is taken to last, for overlaps (FR-009). */
export const WALK_HOURS = 2;
export const MIN_SEATS = 1;
export const MAX_SEATS = 6;
export const NOTE_MAX_LENGTH = 140;
export const PLACE_MAX_LENGTH = 200;
/** Phone numbers are deleted this long after the walk starts (FR-011). */
export const PHONE_KEEP_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function snoozeUntil(now: Date): string {
	return new Date(now.getTime() + SNOOZE_DAYS * DAY_MS).toISOString();
}

export function phoneCutoff(now: Date): string {
	return new Date(now.getTime() - PHONE_KEEP_DAYS * DAY_MS).toISOString();
}

/**
 * Whether this person sees anything of mentor walks at all. Blocked people
 * never do, whatever the setting (FR-039).
 */
export function featureVisible(
	visibility: MentorWalksVisibility,
	viewer: { isAdmin: boolean; isModerator?: boolean },
	blocked: boolean,
): boolean {
	if (blocked) return false;
	if (visibility === 'everyone') return true;
	if (visibility === 'staff') return viewer.isAdmin || viewer.isModerator === true;
	return false;
}

export function isEligible(counts: { completed: number; doors: number }): boolean {
	return counts.completed >= MENTOR_MIN_COMPLETED || counts.doors > MENTOR_MIN_DOORS;
}

export type MentorStatus = 'snoozed' | 'declined' | 'active' | 'revoked';

/** The part of a `mentors` row the panel decision reads. */
export interface MentorState {
	status: MentorStatus;
	snoozedUntil: string | null;
	agreedUrl: string | null;
}

/**
 * Which mentor screen /turfs shows:
 * - `invite`: the invitation (US1), for an eligible person never asked, or
 *   whose snooze has run out.
 * - `agree`: a mentor who hasn't agreed to the current guidelines (FR-005).
 * - `mentor`: Host a walk and their walks (US2).
 * - `declined`: just the quiet "Become a mentor" link.
 * - null: nothing.
 *
 * With no guidelines link set, nobody is invited or asked to agree (FR-036);
 * an agreed mentor can still manage the walks they have.
 */
export type MentorPanelState = 'invite' | 'agree' | 'mentor' | 'declined';

export function mentorPanelState(
	row: MentorState | null,
	eligible: boolean,
	guidelinesUrl: string,
	now: Date,
): MentorPanelState | null {
	const hasGuidelines = guidelinesUrl !== '';
	if (row === null) return eligible && hasGuidelines ? 'invite' : null;
	switch (row.status) {
		case 'revoked':
			return null;
		case 'declined':
			return hasGuidelines ? 'declined' : null;
		case 'snoozed': {
			const due = row.snoozedUntil === null || new Date(row.snoozedUntil) <= now;
			return due && eligible && hasGuidelines ? 'invite' : null;
		}
		case 'active':
			if (row.agreedUrl !== null && (row.agreedUrl === guidelinesUrl || !hasGuidelines)) {
				return 'mentor';
			}
			return hasGuidelines ? 'agree' : null;
	}
}

/** Whether eligibility must be read to decide the panel — it's a query, so
 *  only run it when the answer can matter. */
export function needsEligibility(row: MentorState | null, now: Date): boolean {
	if (row === null) return true;
	return (
		row.status === 'snoozed' && (row.snoozedUntil === null || new Date(row.snoozedUntil) <= now)
	);
}

/** What a mentor typed, tidied but not yet checked. */
export interface WalkInput {
	chapterId: number;
	/** UTC ISO, or null when the date or time was missing or unreadable. */
	startsAt: string | null;
	place: string;
	note: string;
	seats: number;
	phone: string;
}

/** Another of the mentor's live walks, for the overlap rule. */
export interface WalkSlot {
	id: number;
	startsAt: string;
}

export function walksOverlap(a: string, b: string): boolean {
	return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < WALK_HOURS * HOUR_MS;
}

/** Digits with the usual separators, 10 or 11 digits (US). */
export function normalizePhone(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === '') return '';
	if (!/^[+\d\s().-]+$/.test(trimmed)) return null;
	const digits = trimmed.replace(/\D/g, '');
	if (digits.length === 10)
		return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
	if (digits.length === 11 && digits.startsWith('1')) {
		return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
	}
	return null;
}

/**
 * Everything wrong with a walk, as messages for the form (FR-007–FR-010).
 * Empty means it can be saved — once the place is found on the map, which is
 * the caller's job.
 */
export function validateWalk(
	input: WalkInput,
	context: {
		now: Date;
		seatsTaken: number;
		otherWalks: readonly WalkSlot[];
		chapterIds: readonly number[];
	},
): string[] {
	const problems: string[] = [];
	if (!context.chapterIds.includes(input.chapterId)) problems.push('Pick a chapter.');
	if (input.startsAt === null) problems.push('Pick a date and start time.');
	else if (new Date(input.startsAt) <= context.now) problems.push('Pick a time in the future.');
	if (input.place.trim() === '') problems.push('Add a meeting place.');
	else if (input.place.length > PLACE_MAX_LENGTH)
		problems.push(`Keep the meeting place under ${PLACE_MAX_LENGTH} characters.`);
	if (input.note.length > NOTE_MAX_LENGTH)
		problems.push(`Keep the note under ${NOTE_MAX_LENGTH} characters.`);
	if (!Number.isInteger(input.seats) || input.seats < MIN_SEATS || input.seats > MAX_SEATS) {
		problems.push(`Open seats must be between ${MIN_SEATS} and ${MAX_SEATS}.`);
	} else if (input.seats < context.seatsTaken) {
		const n = context.seatsTaken;
		problems.push(
			`${n} ${n === 1 ? 'person has' : 'people have'} already joined, so you need at least ${n} seats.`,
		);
	}
	if (normalizePhone(input.phone) === null)
		problems.push('Enter the phone number as 10 digits, or leave it blank.');
	if (
		input.startsAt !== null &&
		context.otherWalks.some((w) => walksOverlap(w.startsAt, input.startsAt as string))
	) {
		problems.push(`You already have a walk within ${WALK_HOURS} hours of that time.`);
	}
	return problems;
}

const TIME_INPUT = new Intl.DateTimeFormat('en-GB', {
	timeZone: CAMPAIGN_TIME_ZONE,
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});

/** A date input's `YYYY-MM-DD` and a time input's `HH:MM`, read as campaign
 *  local time, as the UTC instant. Null when either is missing or malformed. */
export function walkStartFromInputs(date: string, time: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
	return campaignWallClockToUtc(`${date}T${time}:00`)?.toISOString() ?? null;
}

/** The reverse, to fill the edit form. */
export function walkInputsFromStart(iso: string): { date: string; time: string } {
	return { date: campaignDayKey(iso), time: TIME_INPUT.format(new Date(iso)) };
}

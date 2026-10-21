import { describe, expect, it } from 'vitest';
import {
	featureVisible,
	isEligible,
	mentorPanelState,
	needsEligibility,
	normalizePhone,
	oneLine,
	parseVisibility,
	snoozeUntil,
	validateWalk,
	walkInputsFromStart,
	walkStartFromInputs,
	type MentorState,
	type WalkInput,
	finderState,
	inCardWindow,
	isNew,
	milesBetween,
	walkDayLabel,
	walkEnded,
	walkStarted,
} from './rules.js';

const NOW = new Date('2026-10-18T16:00:00Z');
const URL_A = 'https://example.org/guidelines';

describe('parseVisibility', () => {
	it('keeps the three settings and treats anything else as off', () => {
		expect(parseVisibility('staff')).toBe('staff');
		expect(parseVisibility('everyone')).toBe('everyone');
		expect(parseVisibility(null)).toBe('off');
		expect(parseVisibility('')).toBe('off');
		expect(parseVisibility('Everyone')).toBe('off');
	});
});

describe('featureVisible', () => {
	const volunteer = { isAdmin: false };
	const moderator = { isAdmin: false, isModerator: true };
	const admin = { isAdmin: true };

	it('shows nobody anything when off', () => {
		expect(featureVisible('off', admin, false)).toBe(false);
	});

	it('shows only admins and moderators when staff-only', () => {
		expect(featureVisible('staff', admin, false)).toBe(true);
		expect(featureVisible('staff', moderator, false)).toBe(true);
		expect(featureVisible('staff', volunteer, false)).toBe(false);
	});

	it('never shows a blocked person anything', () => {
		expect(featureVisible('everyone', volunteer, false)).toBe(true);
		expect(featureVisible('everyone', volunteer, true)).toBe(false);
		expect(featureVisible('everyone', admin, true)).toBe(false);
	});
});

describe('isEligible', () => {
	it('needs 4 completions or more than 100 doors', () => {
		expect(isEligible({ completed: 4, doors: 0 })).toBe(true);
		expect(isEligible({ completed: 3, doors: 100 })).toBe(false);
		expect(isEligible({ completed: 0, doors: 101 })).toBe(true);
	});
});

describe('mentorPanelState', () => {
	const row = (over: Partial<MentorState>): MentorState => ({
		status: 'active',
		snoozedUntil: null,
		agreedUrl: URL_A,
		...over,
	});

	it('invites an eligible person never asked, once guidelines are set', () => {
		expect(mentorPanelState(null, true, URL_A, NOW)).toBe('invite');
		expect(mentorPanelState(null, false, URL_A, NOW)).toBeNull();
		expect(mentorPanelState(null, true, '', NOW)).toBeNull();
	});

	it('brings the invitation back only once the snooze has run out', () => {
		const snoozed = row({ status: 'snoozed', snoozedUntil: snoozeUntil(NOW) });
		expect(mentorPanelState(snoozed, true, URL_A, NOW)).toBeNull();
		const later = new Date(NOW.getTime() + 7 * 86_400_000);
		expect(mentorPanelState(snoozed, true, URL_A, later)).toBe('invite');
	});

	it('leaves a declined person only the link back', () => {
		expect(mentorPanelState(row({ status: 'declined' }), true, URL_A, NOW)).toBe('declined');
	});

	it('shows a revoked mentor nothing, eligible or not', () => {
		expect(mentorPanelState(row({ status: 'revoked' }), true, URL_A, NOW)).toBeNull();
	});

	it('asks a mentor to agree again when the link changes', () => {
		expect(mentorPanelState(row({}), false, URL_A, NOW)).toBe('mentor');
		expect(mentorPanelState(row({}), false, 'https://example.org/v2', NOW)).toBe('agree');
		expect(mentorPanelState(row({ agreedUrl: null }), false, URL_A, NOW)).toBe('agree');
	});

	it('lets an agreed mentor keep managing walks if the link is cleared', () => {
		expect(mentorPanelState(row({}), false, '', NOW)).toBe('mentor');
		expect(mentorPanelState(row({ agreedUrl: null }), false, '', NOW)).toBeNull();
	});
});

describe('needsEligibility', () => {
	it('reads eligibility only when it could lead to an invitation', () => {
		expect(needsEligibility(null, NOW)).toBe(true);
		expect(
			needsEligibility({ status: 'snoozed', snoozedUntil: snoozeUntil(NOW), agreedUrl: null }, NOW),
		).toBe(false);
		expect(needsEligibility({ status: 'active', snoozedUntil: null, agreedUrl: URL_A }, NOW)).toBe(
			false,
		);
	});
});

describe('normalizePhone', () => {
	it('formats 10 or 11 digit US numbers and allows blank', () => {
		expect(normalizePhone('734.555.0142')).toBe('(734) 555-0142');
		expect(normalizePhone('+1 734 555 0142')).toBe('(734) 555-0142');
		expect(normalizePhone('  ')).toBe('');
		expect(normalizePhone('555-0142')).toBeNull();
		expect(normalizePhone('call me')).toBeNull();
	});
});

describe('walk start inputs', () => {
	it('round-trips campaign local time', () => {
		const iso = walkStartFromInputs('2026-10-20', '14:00');
		expect(iso).toBe('2026-10-20T18:00:00.000Z'); // EDT
		expect(walkInputsFromStart(iso as string)).toEqual({ date: '2026-10-20', time: '14:00' });
	});

	it('refuses malformed input', () => {
		expect(walkStartFromInputs('', '14:00')).toBeNull();
		expect(walkStartFromInputs('2026-10-20', '2pm')).toBeNull();
	});
});

describe('oneLine', () => {
	it('keeps typed text to one line, so it can’t add lines to a message', () => {
		expect(oneLine('  Red cap\nThis walk has moved\r\n\tto Main St  ')).toBe(
			'Red cap This walk has moved to Main St',
		);
	});
});

describe('validateWalk', () => {
	const input = (over: Partial<WalkInput> = {}): WalkInput => ({
		chapterId: 7,
		startsAt: '2026-10-20T18:00:00.000Z',
		place: 'Ann Arbor District Library, 343 S Fifth Ave',
		note: '',
		lookFor: 'Campaign merch',
		seats: 3,
		phone: '',
		...over,
	});
	const ctx = { now: NOW, seatsTaken: 0, otherWalks: [], chapterIds: [7] };

	it('accepts a good walk', () => {
		expect(validateWalk(input(), ctx)).toEqual([]);
	});

	it('refuses the past, a missing place and bad seats', () => {
		expect(validateWalk(input({ startsAt: '2026-10-18T15:00:00.000Z' }), ctx)).toEqual([
			'Pick a time in the future.',
		]);
		expect(validateWalk(input({ startsAt: null }), ctx)).toEqual(['Pick a date and start time.']);
		expect(validateWalk(input({ place: ' ' }), ctx)).toEqual(['Add a meeting place.']);
		expect(validateWalk(input({ seats: 7 }), ctx)).toEqual(['Open seats must be between 1 and 6.']);
		expect(validateWalk(input({ chapterId: 8 }), ctx)).toEqual(['Pick a chapter.']);
	});

	it('needs a way to spot the mentor, which needn’t be merch', () => {
		expect(validateWalk(input({ lookFor: 'Red cap and a clipboard' }), ctx)).toEqual([]);
		expect(validateWalk(input({ lookFor: '  ' }), ctx)).toEqual([
			'Say how new people will spot you, like “Campaign merch” or “Red cap”.',
		]);
		expect(validateWalk(input({ lookFor: 'x'.repeat(81) }), ctx)).toEqual([
			'Keep how to spot you under 80 characters.',
		]);
	});

	it('refuses fewer seats than are taken', () => {
		expect(validateWalk(input({ seats: 2 }), { ...ctx, seatsTaken: 3 })).toEqual([
			'3 people have already joined, so you need at least 3 seats.',
		]);
	});

	it('refuses a walk within 2 hours of another', () => {
		const other = [{ id: 1, startsAt: '2026-10-20T19:30:00.000Z' }];
		expect(validateWalk(input(), { ...ctx, otherWalks: other })).toEqual([
			'You already have a walk within 2 hours of that time.',
		]);
		const later = [{ id: 1, startsAt: '2026-10-20T20:00:00.000Z' }];
		expect(validateWalk(input(), { ...ctx, otherWalks: later })).toEqual([]);
	});

	it('refuses a bad phone number', () => {
		expect(validateWalk(input({ phone: '12' }), ctx)).toEqual([
			'Enter the phone number as 10 digits, or leave it blank.',
		]);
	});
});

describe('isNew (FR-013)', () => {
	const none = { completed: 0, doors: 0, attended: 0, isMentor: false };
	it('is someone who has never canvassed or attended a walk', () => {
		expect(isNew(none)).toBe(true);
		expect(isNew({ ...none, completed: 1 })).toBe(false);
		expect(isNew({ ...none, doors: 3 })).toBe(false);
		expect(isNew({ ...none, attended: 1 })).toBe(false);
	});
	it('is never a mentor, even an appointed one who has done nothing yet', () => {
		expect(isNew({ ...none, isMentor: true })).toBe(false);
	});
});

describe('finderState (FR-014, FR-017)', () => {
	const prompt = (
		status: 'snoozed' | 'accepted' | 'declined',
		snoozedUntil: string | null = null,
	) => ({
		status,
		snoozedUntil,
	});
	it('asks a new person once, then follows their answer', () => {
		expect(finderState(null, true, NOW)).toBe('prompt');
		expect(finderState(prompt('accepted'), true, NOW)).toBe('cards');
		expect(finderState(prompt('declined'), true, NOW)).toBe('declined');
	});
	it('stays quiet while snoozed, and asks again after', () => {
		expect(finderState(prompt('snoozed', '2026-10-20T00:00:00Z'), true, NOW)).toBeNull();
		expect(finderState(prompt('snoozed', '2026-10-18T00:00:00Z'), true, NOW)).toBe('prompt');
	});
	it('never asks anyone who isn’t new: they get the toggle', () => {
		expect(finderState(null, false, NOW)).toBe('toggle');
		expect(finderState(prompt('declined'), false, NOW)).toBe('toggle');
	});
});

describe('walk windows', () => {
	const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();
	it('shows a card from 3 days out until the walk has ended', () => {
		expect(inCardWindow(at(73), NOW)).toBe(false);
		expect(inCardWindow(at(72), NOW)).toBe(true);
		expect(inCardWindow(at(-1), NOW)).toBe(true);
		expect(inCardWindow(at(-2), NOW)).toBe(false);
	});
	it('knows when a walk has started and ended', () => {
		expect(walkStarted(at(0), NOW)).toBe(true);
		expect(walkStarted(at(1), NOW)).toBe(false);
		expect(walkEnded(at(-2), NOW)).toBe(true);
		expect(walkEnded(at(-1), NOW)).toBe(false);
	});
	it('labels days in campaign time', () => {
		// NOW is noon in Detroit; 1am UTC tomorrow is still tonight there.
		expect(walkDayLabel('2026-10-19T01:00:00Z', NOW)).toBe('Today');
		expect(walkDayLabel('2026-10-19T14:00:00Z', NOW)).toBe('Tomorrow');
		expect(walkDayLabel('2026-10-17T14:00:00Z', NOW)).toBe('Yesterday');
		expect(walkDayLabel('2026-10-22T14:00:00Z', NOW)).toBe('Thu, Oct 22');
	});
});

describe('milesBetween', () => {
	it('measures great-circle miles', () => {
		// Ann Arbor to Ypsilanti, about 7.5 miles apart.
		const miles = milesBetween({ lat: 42.2808, lng: -83.743 }, { lat: 42.2411, lng: -83.6129 });
		expect(miles).toBeGreaterThan(7);
		expect(miles).toBeLessThan(8);
	});
});

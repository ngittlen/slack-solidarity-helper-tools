import { describe, it, expect } from 'vitest';
import {
	assignChapter,
	contactOf,
	countsAsRsvp,
	NO_CHAPTER_ID,
	NO_CHAPTER_NAME,
	rankTopRsvpers,
	sessionsInWindow,
	toCsv,
	trailingWindow,
	type EventRsvp,
	type RosterMember,
} from './top-rsvpers.js';

function member(id: number, chapterIds: number[], overrides: Partial<RosterMember> = {}) {
	return [
		id,
		{
			id,
			fullName: `Member ${id}`,
			email: `m${id}@example.org`,
			phoneNumber: `+1555000${String(id).padStart(4, '0')}`,
			chapterIds,
			...overrides,
		},
	] as const;
}

const chapterNames = new Map([
	[100, 'Alpha'],
	[200, 'Beta'],
]);

describe('trailingWindow', () => {
	it('goes back the given number of calendar months', () => {
		const { startMs, endMs } = trailingWindow(2, new Date('2026-08-09T12:00:00Z'));
		expect(new Date(startMs).toISOString()).toBe('2026-06-09T12:00:00.000Z');
		expect(new Date(endMs).toISOString()).toBe('2026-08-09T12:00:00.000Z');
	});

	it('clamps to the end of a shorter target month', () => {
		// Naive setMonth arithmetic turns May 31 - 2mo into March 3.
		const { startMs } = trailingWindow(2, new Date('2026-05-31T00:00:00Z'));
		expect(new Date(startMs).toISOString().slice(0, 10)).toBe('2026-03-31');
	});

	it('crosses a year boundary', () => {
		const { startMs } = trailingWindow(2, new Date('2026-01-15T00:00:00Z'));
		expect(new Date(startMs).toISOString().slice(0, 10)).toBe('2025-11-15');
	});
});

describe('sessionsInWindow', () => {
	const events = [
		{
			id: 1,
			scope_type: 'Chapter',
			scope_id: 100,
			event_sessions: [
				{ id: 11, start_time: '2026-07-01T00:00:00Z' },
				{ id: 12, start_time: '2026-05-01T00:00:00Z' }, // before the window
			],
		},
		{
			id: 2,
			scope_type: 'Organization',
			scope_id: 5,
			event_sessions: [{ id: 21, start_time: '2026-07-15T00:00:00Z' }],
		},
	];
	const startMs = Date.parse('2026-06-09T00:00:00Z');
	const endMs = Date.parse('2026-08-09T00:00:00Z');

	it('keeps only sessions starting inside the window', () => {
		expect(sessionsInWindow(events, startMs, endMs).map((s) => s.sessionId)).toEqual([11, 21]);
	});

	it('carries the owning chapter, and null when the event is not chapter-scoped', () => {
		const found = sessionsInWindow(events, startMs, endMs);
		expect(found[0]).toEqual({ sessionId: 11, eventId: 1, eventChapterId: 100, rsvpCount: null });
		expect(found[1].eventChapterId).toBeNull();
	});

	it('reports rsvp_count when present, so an empty session can be skipped', () => {
		const counted = [
			{
				id: 4,
				event_sessions: [
					{ id: 41, start_time: '2026-07-01T00:00:00Z', rsvp_count: 0 },
					{ id: 42, start_time: '2026-07-01T00:00:00Z', rsvp_count: 12 },
				],
			},
		];
		expect(sessionsInWindow(counted, startMs, endMs).map((s) => s.rsvpCount)).toEqual([0, 12]);
	});

	it('skips sessions with an unparseable start time', () => {
		const bad = [{ id: 3, event_sessions: [{ id: 31, start_time: 'not a date' }] }];
		expect(sessionsInWindow(bad, startMs, endMs)).toEqual([]);
	});
});

describe('countsAsRsvp', () => {
	it('excludes cancellations in either representation', () => {
		expect(countsAsRsvp({ is_attending: 'no' })).toBe(false);
		expect(countsAsRsvp({ is_attending: false })).toBe(false);
	});

	it('counts yes, maybe and waitlisted', () => {
		expect(countsAsRsvp({ is_attending: 'yes' })).toBe(true);
		expect(countsAsRsvp({ is_attending: 'maybe' })).toBe(true);
		expect(countsAsRsvp({ is_attending: 'waitlisted' })).toBe(true);
	});

	it('counts a row whose status is missing rather than silently dropping it', () => {
		expect(countsAsRsvp({})).toBe(true);
	});
});

describe('assignChapter', () => {
	it('uses the only chapter regardless of whose events they attended', () => {
		expect(assignChapter([100], new Map([[1, 200]]))).toBe(100);
	});

	it('sends a multi-chapter member to where most of their RSVPs went', () => {
		const events = new Map([
			[1, 200],
			[2, 200],
			[3, 100],
		]);
		expect(assignChapter([100, 200], events)).toBe(200);
	});

	it('ignores RSVPs to events owned by a chapter they are not in', () => {
		const events = new Map([
			[1, 300],
			[2, 300],
			[3, 100],
		]);
		expect(assignChapter([100, 200], events)).toBe(100);
	});

	it('breaks a tie on the lowest chapter id so runs are reproducible', () => {
		const events = new Map([
			[1, 100],
			[2, 200],
		]);
		expect(assignChapter([200, 100], events)).toBe(100);
		expect(assignChapter([100, 200], new Map([[1, null]]))).toBe(100);
	});

	it('reports a member with no chapter under the sentinel', () => {
		expect(assignChapter([], new Map())).toBe(NO_CHAPTER_ID);
	});
});

describe('rankTopRsvpers', () => {
	it('counts distinct events, not repeat rows', () => {
		const rsvps: EventRsvp[] = [
			{ userId: 1, eventId: 7, eventChapterId: 100 },
			{ userId: 1, eventId: 7, eventChapterId: 100 },
			{ userId: 1, eventId: 8, eventChapterId: 100 },
		];
		const { rows } = rankTopRsvpers(rsvps, new Map([member(1, [100])]), chapterNames);
		expect(rows).toHaveLength(1);
		expect(rows[0].rsvpCount).toBe(2);
	});

	it('ranks by count and truncates to topN per chapter', () => {
		const rsvps: EventRsvp[] = [];
		// Member 1 -> 3 events, member 2 -> 2, member 3 -> 1.
		for (const [userId, count] of [
			[1, 3],
			[2, 2],
			[3, 1],
		]) {
			for (let e = 0; e < count; e++) rsvps.push({ userId, eventId: e, eventChapterId: 100 });
		}
		const roster = new Map([member(1, [100]), member(2, [100]), member(3, [100])]);
		const { rows } = rankTopRsvpers(rsvps, roster, chapterNames, 2);
		expect(rows.map((r) => r.fullName)).toEqual(['Member 1', 'Member 2']);
		expect(rows.map((r) => r.rsvpCount)).toEqual([3, 2]);
	});

	it('puts a multi-chapter member on exactly one list, with their full count', () => {
		const rsvps: EventRsvp[] = [
			{ userId: 1, eventId: 1, eventChapterId: 200 },
			{ userId: 1, eventId: 2, eventChapterId: 200 },
			{ userId: 1, eventId: 3, eventChapterId: 100 },
		];
		const { rows } = rankTopRsvpers(rsvps, new Map([member(1, [100, 200])]), chapterNames);
		expect(rows).toHaveLength(1);
		expect(rows[0].chapterName).toBe('Beta');
		// Their engagement is 3 events, even though only 2 were Beta's.
		expect(rows[0].rsvpCount).toBe(3);
	});

	it('orders chapters alphabetically with the chapter-less bucket last', () => {
		const rsvps: EventRsvp[] = [
			{ userId: 1, eventId: 1, eventChapterId: 200 },
			{ userId: 2, eventId: 1, eventChapterId: 100 },
			{ userId: 3, eventId: 1, eventChapterId: null },
		];
		const roster = new Map([member(1, [200]), member(2, [100]), member(3, [])]);
		const { rows } = rankTopRsvpers(rsvps, roster, chapterNames);
		expect(rows.map((r) => r.chapterName)).toEqual(['Alpha', 'Beta', NO_CHAPTER_NAME]);
	});

	it('labels a chapter missing from the name list by id rather than dropping it', () => {
		const rsvps: EventRsvp[] = [{ userId: 1, eventId: 1, eventChapterId: 900 }];
		const { rows } = rankTopRsvpers(rsvps, new Map([member(1, [900])]), chapterNames);
		expect(rows[0].chapterName).toBe('Chapter 900');
	});

	it('falls back to the RSVP contact card when the roster has no record', () => {
		const rsvps: EventRsvp[] = [
			{ userId: 1, eventId: 1, eventChapterId: 100 },
			{
				userId: 99,
				eventId: 1,
				eventChapterId: 100,
				contact: { fullName: 'Grace Hopper', email: 'gh@example.org', phoneNumber: '12025550100' },
			},
		];
		const { rows, unmatchedUserIds } = rankTopRsvpers(
			rsvps,
			new Map([member(1, [100])]),
			chapterNames,
		);
		expect(unmatchedUserIds).toEqual([99]);
		const fallback = rows.find((r) => r.fullName === 'Grace Hopper');
		// No roster record means no chapter — reported, not guessed at.
		expect(fallback?.chapterName).toBe(NO_CHAPTER_NAME);
		expect(fallback?.email).toBe('gh@example.org');
	});

	it('prefers the roster over the contact card when both exist', () => {
		const rsvps: EventRsvp[] = [
			{
				userId: 1,
				eventId: 1,
				eventChapterId: 100,
				contact: { fullName: 'Stale Name', email: 'stale@example.org', phoneNumber: '' },
			},
		];
		const { rows } = rankTopRsvpers(rsvps, new Map([member(1, [100])]), chapterNames);
		expect(rows[0].fullName).toBe('Member 1');
		expect(rows[0].chapterName).toBe('Alpha');
	});

	it('folds duplicate Solidarity profiles for one person into a single row', () => {
		// The live run put one member in a chapter's top ten twice, with her RSVPs
		// split across two records so both counts understated her.
		const rsvps: EventRsvp[] = [
			{ userId: 1, eventId: 10, eventChapterId: 100 },
			{ userId: 1, eventId: 11, eventChapterId: 100 },
			{ userId: 2, eventId: 12, eventChapterId: 100 },
		];
		const roster = new Map([
			member(1, [100], { email: 'dup@example.org', fullName: 'Lisa Lenzo' }),
			member(2, [100], { email: 'DUP@example.org', fullName: 'lisa  lenzo' }),
		]);
		const { rows, duplicateProfilesMerged } = rankTopRsvpers(rsvps, roster, chapterNames);
		expect(rows).toHaveLength(1);
		expect(rows[0].rsvpCount).toBe(3);
		// Lowest id wins, so the surviving details don't change between runs.
		expect(rows[0].fullName).toBe('Lisa Lenzo');
		expect(duplicateProfilesMerged).toBe(1);
	});

	it('does NOT pool strangers who share a placeholder email', () => {
		// 29 different people in the live data share noemail@gmail.com. Keying on
		// the address alone merged them into one member who topped their chapter.
		const rsvps: EventRsvp[] = [
			{ userId: 1, eventId: 10, eventChapterId: 100 },
			{ userId: 2, eventId: 11, eventChapterId: 100 },
			{ userId: 3, eventId: 12, eventChapterId: 100 },
		];
		const roster = new Map([
			member(1, [100], { email: 'noemail@gmail.com', fullName: 'Jesus Christ' }),
			member(2, [100], { email: 'noemail@gmail.com', fullName: 'Stellan Muller' }),
			member(3, [100], { email: 'noemail@gmail.com', fullName: 'Jessica Kent' }),
		]);
		const { rows, duplicateProfilesMerged } = rankTopRsvpers(rsvps, roster, chapterNames);
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.rsvpCount === 1)).toBe(true);
		expect(duplicateProfilesMerged).toBe(0);
	});

	it('counts an event once when both duplicate profiles RSVP’d to it', () => {
		const rsvps: EventRsvp[] = [
			{ userId: 1, eventId: 10, eventChapterId: 100 },
			{ userId: 2, eventId: 10, eventChapterId: 100 },
		];
		const roster = new Map([
			member(1, [100], { email: 'dup@example.org', fullName: 'Same Person' }),
			member(2, [100], { email: 'dup@example.org', fullName: 'Same Person' }),
		]);
		expect(rankTopRsvpers(rsvps, roster, chapterNames).rows[0].rsvpCount).toBe(1);
	});

	it('unions the chapters of merged profiles before assigning one', () => {
		const rsvps: EventRsvp[] = [
			{ userId: 1, eventId: 10, eventChapterId: 200 },
			{ userId: 2, eventId: 11, eventChapterId: 200 },
		];
		const roster = new Map([
			member(1, [100], { email: 'dup@example.org', fullName: 'Same Person' }),
			member(2, [200], { email: 'dup@example.org', fullName: 'Same Person' }),
		]);
		const { rows } = rankTopRsvpers(rsvps, roster, chapterNames);
		expect(rows).toHaveLength(1);
		expect(rows[0].chapterName).toBe('Beta');
	});

	it('keeps profiles with no email apart rather than merging them', () => {
		const rsvps: EventRsvp[] = [
			{ userId: 1, eventId: 10, eventChapterId: 100 },
			{ userId: 2, eventId: 11, eventChapterId: 100 },
		];
		const roster = new Map([
			member(1, [100], { email: '', fullName: 'No Email One' }),
			member(2, [100], { email: '', fullName: 'No Email Two' }),
		]);
		const { rows, duplicateProfilesMerged } = rankTopRsvpers(rsvps, roster, chapterNames);
		expect(rows).toHaveLength(2);
		expect(duplicateProfilesMerged).toBe(0);
	});

	it('does not merge two people who only share a phone number', () => {
		// Households share a number far more often than an inbox.
		const rsvps: EventRsvp[] = [
			{ userId: 1, eventId: 10, eventChapterId: 100 },
			{ userId: 2, eventId: 11, eventChapterId: 100 },
		];
		const roster = new Map([
			member(1, [100], { email: 'a@example.org', phoneNumber: '12025550100' }),
			member(2, [100], { email: 'b@example.org', phoneNumber: '12025550100' }),
		]);
		expect(rankTopRsvpers(rsvps, roster, chapterNames).rows).toHaveLength(2);
	});

	it('skips a member with neither a roster record nor a contact card', () => {
		const rsvps: EventRsvp[] = [{ userId: 99, eventId: 1, eventChapterId: 100 }];
		const { rows, unmatchedUserIds } = rankTopRsvpers(rsvps, new Map(), chapterNames);
		expect(rows).toEqual([]);
		expect(unmatchedUserIds).toEqual([99]);
	});
});

describe('contactOf', () => {
	it('builds a contact from the trimmed user_details card', () => {
		expect(
			contactOf({
				user_id: 5,
				user_details: {
					first_name: 'Ada',
					last_name: 'Lovelace',
					email: 'ada@example.org',
					phone: '12025550101',
				},
			}),
		).toEqual({ fullName: 'Ada Lovelace', email: 'ada@example.org', phoneNumber: '12025550101' });
	});

	it('returns undefined when the row carries nothing usable', () => {
		expect(contactOf({ user_id: 5 })).toBeUndefined();
		expect(
			contactOf({ user_id: 5, user_details: { first_name: '  ', email: '' } }),
		).toBeUndefined();
	});

	it('falls back to the email, then the id, for a nameless card', () => {
		expect(contactOf({ user_id: 5, user_details: { email: 'x@example.org' } })?.fullName).toBe(
			'x@example.org',
		);
		expect(contactOf({ user_id: 5, user_details: { phone: '12025550101' } })?.fullName).toBe(
			'Solidarity user 5',
		);
	});
});

describe('toCsv', () => {
	it('writes the requested header and columns', () => {
		const rsvps: EventRsvp[] = [{ userId: 1, eventId: 1, eventChapterId: 100 }];
		const { rows } = rankTopRsvpers(rsvps, new Map([member(1, [100])]), chapterNames);
		const lines = toCsv(rows).trimEnd().split('\n');
		expect(lines[0]).toBe(
			'Chapter Name,RSVP count (over the past two months),Full Name,Email,Phone Number',
		);
		expect(lines[1]).toBe('Alpha,1,Member 1,m1@example.org,+15550000001');
	});

	it('quotes and escapes values that would otherwise break the row', () => {
		const rsvps: EventRsvp[] = [{ userId: 1, eventId: 1, eventChapterId: 100 }];
		const roster = new Map([member(1, [100], { fullName: 'Ada "Boss" Lovelace, Jr.' })]);
		const { rows } = rankTopRsvpers(rsvps, roster, chapterNames);
		expect(toCsv(rows)).toContain('"Ada ""Boss"" Lovelace, Jr."');
	});
});

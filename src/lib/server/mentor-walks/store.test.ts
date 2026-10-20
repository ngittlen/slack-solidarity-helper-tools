import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
	agreeToGuidelines,
	answerInvite,
	appointMentor,
	cancelWalk,
	createWalk,
	eligibilityCounts,
	latestPhone,
	listMentorWalks,
	listMentors,
	listWalksForOrganizer,
	mentorTotals,
	loadMentor,
	loadWalk,
	mentorStats,
	purgeExpiredPhones,
	reinstateMentor,
	revokeMentor,
	setWalkStatus,
	updateWalk,
	type WalkFields,
} from './store.js';
import { blockFromTurfCheckout } from '../van/blocklist.js';

// A real in-memory libsql: the overlap and has-it-started rules live in the
// SQL, so a fake would only answer what the test scripted.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-10-18T16:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();
const MENTOR = { id: 'U_MENTOR', name: 'Kimberly R.' };
const ADMIN = { id: 'U_ADMIN', name: 'Alex' };
const URL_A = 'https://example.org/guidelines';

const fields = (over: Partial<WalkFields> = {}): WalkFields => ({
	chapterId: 71,
	startsAt: at(26),
	place: 'Ann Arbor District Library, 343 S Fifth Ave',
	lat: 42.278,
	lng: -83.746,
	note: '',
	seats: 3,
	phone: '(734) 555-0142',
	...over,
});

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

describe('eligibilityCounts', () => {
	it('counts completed checkouts and their doors only', async () => {
		const rows: Array<[string | null, number | null, number | null]> = [
			[NOW.toISOString(), 40, null],
			[NOW.toISOString(), null, 25],
			[null, 99, null],
		];
		for (const [completedAt, knocked, delta] of rows) {
			await client.execute({
				sql: `INSERT INTO van_turf_checkouts
				        (turf_id, slack_user_id, slack_user_name, claimed_at, expires_at, completed_at,
				         doors_knocked, confirmed_door_delta)
				      VALUES (1, 'U_MENTOR', 'K', ?, ?, ?, ?, ?)`,
				args: [NOW.toISOString(), at(48), completedAt, knocked, delta],
			});
		}
		expect(await eligibilityCounts(db, MENTOR.id)).toEqual({ completed: 2, doors: 65 });
		expect(await eligibilityCounts(db, 'U_NOBODY')).toEqual({ completed: 0, doors: 0 });
	});
});

describe('mentor status', () => {
	it('snoozes for 7 days and remembers a decline', async () => {
		await answerInvite(db, MENTOR, 'snooze', NOW);
		expect(await loadMentor(db, MENTOR.id)).toMatchObject({
			status: 'snoozed',
			snoozedUntil: '2026-10-25T16:00:00.000Z',
		});
		await answerInvite(db, MENTOR, 'decline', NOW);
		expect(await loadMentor(db, MENTOR.id)).toMatchObject({
			status: 'declined',
			snoozedUntil: null,
		});
	});

	it('makes someone a mentor when they agree, recording the link', async () => {
		expect(await agreeToGuidelines(db, MENTOR, URL_A, NOW)).toBe(true);
		expect(await loadMentor(db, MENTOR.id)).toMatchObject({
			status: 'active',
			agreedUrl: URL_A,
			agreedAt: NOW.toISOString(),
		});
	});

	it('lets an organizer appoint someone who still has to agree', async () => {
		expect(await appointMentor(db, MENTOR, ADMIN, NOW)).toBe(true);
		expect(await loadMentor(db, MENTOR.id)).toMatchObject({
			status: 'active',
			appointedBy: ADMIN.id,
			agreedUrl: null,
		});
		// Already a mentor: neither appointed twice nor snoozed out of it.
		expect(await appointMentor(db, MENTOR, ADMIN, NOW)).toBe(false);
		expect(await answerInvite(db, MENTOR, 'snooze', NOW)).toBe(false);
		expect((await loadMentor(db, MENTOR.id))?.status).toBe('active');
	});

	it('never writes over a revoke, even from a stale screen', async () => {
		await agreeToGuidelines(db, MENTOR, URL_A, NOW);
		await revokeMentor(db, MENTOR.id, ADMIN, NOW);
		expect(await appointMentor(db, MENTOR, ADMIN, NOW)).toBe(false);
		expect(await agreeToGuidelines(db, MENTOR, URL_A, NOW)).toBe(false);
		expect((await loadMentor(db, MENTOR.id))?.status).toBe('revoked');
	});

	it('revoking cancels upcoming walks and keeps the mentor out until reinstated', async () => {
		await agreeToGuidelines(db, MENTOR, URL_A, NOW);
		const walk = await createWalk(db, MENTOR, fields(), NOW);
		expect(walk.ok).toBe(true);

		const cancelled = await revokeMentor(db, MENTOR.id, ADMIN, NOW);
		expect(cancelled).toEqual([walk.ok ? walk.id : -1]);
		expect(await listMentorWalks(db, MENTOR.id, NOW)).toEqual([]);

		// Neither the invitation nor agreeing gets them back in.
		expect(await answerInvite(db, MENTOR, 'snooze', NOW)).toBe(false);
		expect(await agreeToGuidelines(db, MENTOR, URL_A, NOW)).toBe(false);
		expect((await loadMentor(db, MENTOR.id))?.status).toBe('revoked');

		expect(await reinstateMentor(db, MENTOR.id, ADMIN, NOW)).toBe(true);
		expect(await loadMentor(db, MENTOR.id)).toMatchObject({ status: 'active', agreedUrl: URL_A });
		expect((await listMentors(db)).map((m) => m.holderId)).toEqual([MENTOR.id]);
	});
});

describe('blocking', () => {
	it('revokes an active mentor and cancels their walks', async () => {
		await agreeToGuidelines(db, MENTOR, URL_A, NOW);
		await createWalk(db, MENTOR, fields({ startsAt: at(24 * 30) }), NOW);
		await blockFromTurfCheckout(
			db,
			{ slackUserId: MENTOR.id, displayName: MENTOR.name, reason: 'test' },
			ADMIN,
		);
		expect((await loadMentor(db, MENTOR.id))?.status).toBe('revoked');
		expect(await listMentorWalks(db, MENTOR.id, NOW)).toEqual([]);
	});

	it('leaves someone who never became a mentor without a row', async () => {
		await blockFromTurfCheckout(
			db,
			{ slackUserId: 'U_OTHER', displayName: 'Other', reason: 'test' },
			ADMIN,
		);
		expect(await loadMentor(db, 'U_OTHER')).toBeNull();
	});
});

describe('walks', () => {
	it('creates, lists and pre-fills the phone', async () => {
		const result = await createWalk(db, MENTOR, fields(), NOW);
		expect(result.ok).toBe(true);
		expect((await listMentorWalks(db, MENTOR.id, NOW)).map((w) => w.place)).toEqual([
			'Ann Arbor District Library, 343 S Fifth Ave',
		]);
		expect(await latestPhone(db, MENTOR.id)).toBe('(734) 555-0142');
	});

	it('refuses an overlapping walk, but not one 2 hours later', async () => {
		await createWalk(db, MENTOR, fields(), NOW);
		expect(await createWalk(db, MENTOR, fields({ startsAt: at(27) }), NOW)).toEqual({
			ok: false,
			message: 'You already have a walk within 2 hours of that time.',
		});
		expect((await createWalk(db, MENTOR, fields({ startsAt: at(28) }), NOW)).ok).toBe(true);
		// Someone else's walk at the same time is no clash.
		expect((await createWalk(db, ADMIN, fields(), NOW)).ok).toBe(true);
	});

	it('edits up to the start, and not into an overlap', async () => {
		const first = await createWalk(db, MENTOR, fields(), NOW);
		await createWalk(db, MENTOR, fields({ startsAt: at(30) }), NOW);
		if (!first.ok) throw new Error('create failed');

		const moved = await updateWalk(db, MENTOR.id, first.id, fields({ startsAt: at(29) }), NOW);
		expect(moved).toEqual({
			ok: false,
			message: 'You already have a walk within 2 hours of that time.',
		});
		const ok = await updateWalk(db, MENTOR.id, first.id, fields({ seats: 5 }), NOW);
		expect(ok).toEqual({ ok: true, id: first.id });
		expect((await loadWalk(db, first.id))?.seats).toBe(5);

		const later = new Date(NOW.getTime() + 27 * HOUR);
		expect(await updateWalk(db, MENTOR.id, first.id, fields(), later)).toEqual({
			ok: false,
			message: 'That walk has already started, so it can’t be changed.',
		});
		// Nor can someone else edit it.
		expect((await updateWalk(db, ADMIN.id, first.id, fields(), NOW)).ok).toBe(false);
	});

	it('cancels only before the start, and only the mentor’s own', async () => {
		const walk = await createWalk(db, MENTOR, fields(), NOW);
		if (!walk.ok) throw new Error('create failed');
		expect(await cancelWalk(db, ADMIN, walk.id, NOW)).toBe(false);
		expect(await cancelWalk(db, MENTOR, walk.id, new Date(NOW.getTime() + 27 * HOUR))).toBe(false);
		expect(await cancelWalk(db, MENTOR, walk.id, NOW)).toBe(true);
		expect((await loadWalk(db, walk.id))?.status).toBe('cancelled');
		// A cancelled walk no longer blocks the slot.
		expect((await createWalk(db, MENTOR, fields(), NOW)).ok).toBe(true);
	});

	it('counts walks hosted once they have started', async () => {
		await createWalk(db, MENTOR, fields({ startsAt: at(1) }), NOW);
		await createWalk(db, MENTOR, fields({ startsAt: at(26) }), NOW);
		const later = new Date(NOW.getTime() + 2 * HOUR);
		expect(await mentorStats(db, MENTOR.id, later)).toEqual({
			walksHosted: 1,
			newPeopleTakenOut: 0,
		});
	});
});

describe('organizers', () => {
	it('lists upcoming and recent walks of every status, and hides one', async () => {
		const walk = await createWalk(db, MENTOR, fields(), NOW);
		await createWalk(db, MENTOR, fields({ startsAt: at(-5) }), new Date(NOW.getTime() - 10 * HOUR));
		if (!walk.ok) throw new Error('create failed');

		expect(await setWalkStatus(db, walk.id, 'hidden', ADMIN, NOW)).toBe(true);
		// Already hidden: nothing to do.
		expect(await setWalkStatus(db, walk.id, 'cancelled', ADMIN, NOW)).toBe(false);

		expect(await mentorTotals(db, NOW)).toEqual(
			new Map([[MENTOR.id, { walksHosted: 1, lastChapterId: 71 }]]),
		);

		const { upcoming, past } = await listWalksForOrganizer(db, NOW);
		expect(upcoming.map((w) => [w.id, w.status, w.statusByName])).toEqual([
			[walk.id, 'hidden', 'Alex'],
		]);
		expect(past).toHaveLength(1);
	});
});

describe('purgeExpiredPhones', () => {
	it('deletes numbers a day after the walk started', async () => {
		const old = await createWalk(db, MENTOR, fields({ startsAt: at(-25) }), new Date(0));
		const recent = await createWalk(db, MENTOR, fields({ startsAt: at(-23) }), new Date(0));
		if (!old.ok || !recent.ok) throw new Error('create failed');
		expect(await purgeExpiredPhones(db, NOW)).toBe(1);
		expect((await loadWalk(db, old.id))?.phone).toBeNull();
		expect((await loadWalk(db, recent.id))?.phone).toBe('(734) 555-0142');
	});
});

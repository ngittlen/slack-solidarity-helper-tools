import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { mentorWalkMessages, mentorWalks, mentorWalkSeats, vanTurfCheckouts } from '../schema.js';
import {
	agreeToGuidelines,
	campaignMetrics,
	createWalk,
	mentorStats,
	revokeMentor,
	setWalkStatus,
	updateWalk,
	type WalkFields,
} from './store.js';
import {
	answerWalk,
	attendedCount,
	cardWalks,
	countWalksNear,
	heldSeats,
	joinWalk,
	leaveWalk,
	MAX_JOINS_PER_WALK,
	releaseSeatsOf,
	saveAttendance,
	walksAwaitingCheckin,
} from './seats.js';
import { queueCheckins, queueJoined } from './walk-events.js';

// A real in-memory libsql: the seat rules (FR-018, FR-019) are written into
// the INSERT, so only a real database can show they hold.

let db: ReturnType<typeof drizzle>;

const NOW = new Date('2026-10-18T16:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();
const later = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
const MENTOR = { id: 'U_MENTOR', name: 'Kimberly R.' };
const ADMIN = { id: 'U_ADMIN', name: 'Alex' };
const SAM = { id: 'U_SAM', name: 'Sam R.' };
const PRIYA = { id: 'google:priya', name: 'Priya K.' };
const DEV = { id: 'U_DEV', name: 'Dev M.' };

const fields = (over: Partial<WalkFields> = {}): WalkFields => ({
	chapterId: 71,
	startsAt: at(26),
	place: 'Ann Arbor District Library, 343 S Fifth Ave',
	lat: 42.278,
	lng: -83.746,
	note: '',
	lookFor: 'Campaign merch',
	seats: 2,
	phone: '(734) 555-0142',
	...over,
});

async function postWalk(over: Partial<WalkFields> = {}): Promise<number> {
	const walk = await createWalk(db, MENTOR, fields(over), NOW);
	if (!walk.ok) throw new Error(walk.message);
	return walk.id;
}

async function messages() {
	return db
		.select({
			holderId: mentorWalkMessages.holderId,
			eventKey: mentorWalkMessages.eventKey,
			kind: mentorWalkMessages.kind,
		})
		.from(mentorWalkMessages);
}

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	db = drizzle(createClient({ url: ':memory:' }));
	await migrate(db, { migrationsFolder: 'drizzle' });
	await agreeToGuidelines(db, MENTOR, 'https://example.org/g', NOW);
});

describe('joining', () => {
	it('takes a seat, and refuses once the walk is full', async () => {
		const id = await postWalk({ seats: 2 });
		expect((await joinWalk(db, SAM, id, true, NOW)).ok).toBe(true);
		expect((await joinWalk(db, PRIYA, id, true, NOW)).ok).toBe(true);
		expect(await joinWalk(db, DEV, id, true, NOW)).toEqual({ ok: false, reason: 'full' });
		expect((await heldSeats(db, [id])).get(id)?.map((s) => s.holderName)).toEqual([
			'Sam R.',
			'Priya K.',
		]);
	});

	it('gives the last seat to exactly one of two people joining at once', async () => {
		const id = await postWalk({ seats: 1 });
		const results = await Promise.all([
			joinWalk(db, SAM, id, true, NOW),
			joinWalk(db, PRIYA, id, true, NOW),
		]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: 'full' });
		expect((await heldSeats(db, [id])).get(id)).toHaveLength(1);
	});

	it('refuses the mentor’s own walk, a walk that has started, and an overlapping seat', async () => {
		const first = await postWalk({ startsAt: at(26) });
		const close = await createWalk(
			db,
			{ id: 'U_OTHER', name: 'Sara G.' },
			fields({ startsAt: at(27) }),
			NOW,
		);
		if (!close.ok) throw new Error('create failed');
		expect(await joinWalk(db, MENTOR, first, false, NOW)).toEqual({ ok: false, reason: 'own' });
		expect(await joinWalk(db, SAM, first, true, later(27))).toEqual({
			ok: false,
			reason: 'started',
		});
		expect((await joinWalk(db, SAM, first, true, NOW)).ok).toBe(true);
		expect(await joinWalk(db, SAM, close.id, true, NOW)).toEqual({
			ok: false,
			reason: 'overlap',
		});
		expect(await joinWalk(db, SAM, first, true, NOW)).toEqual({ ok: false, reason: 'already' });
	});

	it('refuses a cancelled or hidden walk as gone', async () => {
		const id = await postWalk();
		await setWalkStatus(db, id, 'hidden', ADMIN, NOW);
		expect(await joinWalk(db, SAM, id, true, NOW)).toEqual({ ok: false, reason: 'gone' });
		expect(await joinWalk(db, SAM, 999, true, NOW)).toEqual({ ok: false, reason: 'gone' });
	});

	it('takes a given-up seat back rather than adding a second', async () => {
		const id = await postWalk();
		await joinWalk(db, SAM, id, true, NOW);
		expect(await leaveWalk(db, SAM.id, id, NOW)).not.toBeNull();
		expect((await heldSeats(db, [id])).get(id)).toBeUndefined();
		expect((await joinWalk(db, SAM, id, true, NOW)).ok).toBe(true);
		expect((await heldSeats(db, [id])).get(id)).toHaveLength(1);
	});

	it('stops someone joining and leaving one walk over and over', async () => {
		const id = await postWalk();
		for (let i = 1; i <= MAX_JOINS_PER_WALK; i++) {
			expect((await joinWalk(db, SAM, id, true, NOW)).ok).toBe(true);
			await leaveWalk(db, SAM.id, id, NOW);
		}
		expect(await joinWalk(db, SAM, id, true, NOW)).toEqual({ ok: false, reason: 'too-often' });
		// Someone else still can.
		expect((await joinWalk(db, DEV, id, true, NOW)).ok).toBe(true);
	});
});

describe('the cards', () => {
	it('shows the 5 soonest walks starting within a week', async () => {
		const days = [6, 1, 8, 3, 2, 5, 4];
		const ids = new Map<number, number>();
		for (const d of days) ids.set(d, await postWalk({ startsAt: at(d * 24) }));
		const cards = await cardWalks(db, 71, NOW);
		expect(cards.map((w) => w.id)).toEqual([1, 2, 3, 4, 5].map((d) => ids.get(d)));
	});

	it('shows walks under way besides the 5, as nobody can join them', async () => {
		const started = await postWalk({ startsAt: at(1) });
		const ids = [];
		for (const d of [1, 2, 3, 4, 5, 6]) ids.push(await postWalk({ startsAt: at(d * 24) }));
		const cards = await cardWalks(db, 71, later(1.5));
		expect(cards.map((w) => w.id)).toEqual([started, ...ids.slice(0, 5)]);
	});

	it('shows the viewer’s own walks besides the 5, held or hosted', async () => {
		const ids = [];
		for (const d of [1, 2, 3, 4, 5, 6]) ids.push(await postWalk({ startsAt: at(d * 24) }));
		const joined = await joinWalk(db, SAM, ids[5], true, NOW);
		if (!joined.ok) throw new Error('join failed');
		const held = { viewerId: SAM.id, heldIds: new Set([ids[5]]) };
		expect((await cardWalks(db, 71, NOW, held)).map((w) => w.id)).toEqual(ids);
		expect((await cardWalks(db, 71, NOW, { viewerId: MENTOR.id })).map((w) => w.id)).toEqual(ids);
		expect((await cardWalks(db, 71, NOW, { viewerId: PRIYA.id })).map((w) => w.id)).toEqual(
			ids.slice(0, 5),
		);
	});

	it('shows full walks besides the 5, as nobody can join them', async () => {
		const full = await postWalk({ startsAt: at(12), seats: 1 });
		if (!(await joinWalk(db, DEV, full, true, NOW)).ok) throw new Error('join failed');
		const ids = [];
		for (const d of [1, 2, 3, 4, 5, 6]) ids.push(await postWalk({ startsAt: at(d * 24) }));
		const cards = await cardWalks(db, 71, NOW);
		expect(cards.map((w) => w.id)).toEqual([full, ...ids.slice(0, 5)]);
	});

	it('counts a linked walk among the 5 when it is one of them', async () => {
		const ids = [];
		for (const d of [1, 2, 3, 4, 5, 6]) ids.push(await postWalk({ startsAt: at(d * 24) }));
		const [first] = await db.select().from(mentorWalks).where(eq(mentorWalks.id, ids[0]));
		const cards = await cardWalks(db, 71, NOW, { linkedId: first.publicId });
		expect(cards.map((w) => w.id)).toEqual(ids.slice(0, 5));
	});

	it('always shows the walk a message linked to, however far off or far down', async () => {
		const ids = [];
		for (const d of [1, 2, 3, 4, 5, 6, 10]) ids.push(await postWalk({ startsAt: at(d * 24) }));
		const publicIds = await db.select().from(mentorWalks);
		const publicId = (id: number) => publicIds.find((w) => w.id === id)!.publicId;
		for (const linked of [ids[5], ids[6]]) {
			const cards = await cardWalks(db, 71, NOW, { linkedId: publicId(linked) });
			expect(cards.map((w) => w.id)).toEqual([...ids.slice(0, 5), linked]);
		}
	});
});

describe('countWalksNear', () => {
	const LIBRARY = { lat: 42.278, lng: -83.746 };

	it('counts joinable walks this week within the radius, in offered chapters', async () => {
		await postWalk({ startsAt: at(26) });
		await postWalk({ startsAt: at(50), lat: 42.29 });
		// About 8 miles north: out of a 2-mile radius.
		await postWalk({ startsAt: at(74), lat: 42.4 });
		// In a chapter /turfs doesn't offer.
		await postWalk({ startsAt: at(98), chapterId: 72 });
		// Past the week.
		await postWalk({ startsAt: at(8 * 24) });
		expect(await countWalksNear(db, LIBRARY, 2, [71], NOW)).toBe(2);
		expect(await countWalksNear(db, LIBRARY, 2, [71, 72], NOW)).toBe(3);
		expect(await countWalksNear(db, LIBRARY, 2, [], NOW)).toBe(0);
	});

	it('leaves out a walk already under way', async () => {
		await postWalk({ startsAt: at(26) });
		expect(await countWalksNear(db, LIBRARY, 2, [71], later(26.5))).toBe(0);
	});
});

describe('giving a seat up', () => {
	it('works until the start, and not after', async () => {
		const id = await postWalk({ startsAt: at(2) });
		await joinWalk(db, SAM, id, true, NOW);
		expect(await leaveWalk(db, SAM.id, id, later(3))).toBeNull();
		expect(await leaveWalk(db, SAM.id, id, NOW)).not.toBeNull();
		expect(await leaveWalk(db, SAM.id, id, NOW)).toBeNull();
	});

	it('frees every upcoming seat of someone blocked', async () => {
		const id = await postWalk();
		await joinWalk(db, SAM, id, true, NOW);
		expect((await releaseSeatsOf(db, SAM.id, NOW)).map((s) => s.walkId)).toEqual([id]);
		expect((await heldSeats(db, [id])).get(id)).toBeUndefined();
	});
});

describe('the mentor changing a walk', () => {
	it('can’t cut the seats below the number taken', async () => {
		const id = await postWalk({ seats: 3 });
		await joinWalk(db, SAM, id, true, NOW);
		await joinWalk(db, PRIYA, id, true, NOW);
		expect(await updateWalk(db, MENTOR.id, id, fields({ seats: 1 }), NOW)).toEqual({
			ok: false,
			message: '2 people have already joined, so you need at least 2 seats.',
		});
		expect((await updateWalk(db, MENTOR.id, id, fields({ seats: 2 }), NOW)).ok).toBe(true);
	});

	it('tells seat holders about a new time, once per change, and not about a new note', async () => {
		const id = await postWalk();
		await joinWalk(db, SAM, id, true, NOW);
		await updateWalk(db, MENTOR.id, id, fields({ note: 'By the doors' }), NOW);
		expect(await messages()).toEqual([]);
		await updateWalk(db, MENTOR.id, id, fields({ startsAt: at(28) }), later(1));
		expect(await messages()).toEqual([
			{ holderId: SAM.id, eventKey: `changed:${id}:${at(1)}`, kind: 'walk-changed' },
		]);
	});

	it('tells seat holders when the walk is off, once, however it went', async () => {
		const id = await postWalk();
		await joinWalk(db, SAM, id, true, NOW);
		await joinWalk(db, PRIYA, id, true, NOW);
		await revokeMentor(db, MENTOR.id, ADMIN, NOW);
		await setWalkStatus(db, id, 'hidden', ADMIN, NOW);
		const sent = await messages();
		expect(sent.filter((m) => m.kind === 'walk-off').map((m) => m.holderId)).toEqual([
			SAM.id,
			PRIYA.id,
		]);
		expect(sent.filter((m) => m.kind === 'mentor-revoked').map((m) => m.holderId)).toEqual([
			MENTOR.id,
		]);
	});

	it('queues one join message per seat taken, however often it is processed', async () => {
		const id = await postWalk();
		const joined = await joinWalk(db, SAM, id, true, NOW);
		if (!joined.ok) throw new Error('join failed');
		const [walk] = await cardWalks(db, 71, NOW);
		const seat = { id: joined.seatId, holderName: SAM.name, joinedAt: NOW.toISOString() };
		await queueJoined(db, walk, seat, NOW);
		await queueJoined(db, walk, seat, NOW);
		expect(await messages()).toEqual([
			{
				holderId: MENTOR.id,
				eventKey: `join:${joined.seatId}:${NOW.toISOString()}`,
				kind: 'walk-joined',
			},
		]);
	});
});

describe('after the walk', () => {
	it('asks the mentor who showed up, unless they’ve stopped being a mentor since', async () => {
		const id = await postWalk();
		await joinWalk(db, SAM, id, true, NOW);
		const started = later(27);
		await queueCheckins(db, started);
		expect((await messages()).map((m) => m.eventKey).sort()).toEqual([
			`checkin:${id}`,
			`howdid:${id}`,
		]);

		const second = await postWalk({ startsAt: at(50) });
		await joinWalk(db, SAM, second, true, NOW);
		await revokeMentor(db, MENTOR.id, ADMIN, later(51));
		await queueCheckins(db, later(51));
		const keys = (await messages()).map((m) => m.eventKey);
		expect(keys).toContain(`howdid:${second}`);
		expect(keys).not.toContain(`checkin:${second}`);
	});

	it('takes answers only once it has started, and lets them change', async () => {
		const id = await postWalk({ startsAt: at(2) });
		await joinWalk(db, SAM, id, true, NOW);
		expect(await answerWalk(db, SAM.id, id, 'went', NOW)).toBe(false);
		expect(await answerWalk(db, SAM.id, id, 'no-show', later(3))).toEqual({ previous: null });
		expect(await answerWalk(db, SAM.id, id, 'went', later(4))).toEqual({ previous: 'no-show' });
		expect(await answerWalk(db, DEV.id, id, 'went', later(4))).toBe(false);
	});

	it('counts a tick or an “I went” as attending, which ends being new, with no doors', async () => {
		const id = await postWalk({ startsAt: at(2) });
		await joinWalk(db, SAM, id, true, NOW);
		await joinWalk(db, PRIYA, id, true, NOW);
		expect(await walksAwaitingCheckin(db, MENTOR.id, later(3))).toHaveLength(1);

		const seats = (await heldSeats(db, [id])).get(id) ?? [];
		const sam = seats.find((s) => s.holderId === SAM.id);
		expect(await saveAttendance(db, MENTOR.id, id, [sam!.id], NOW)).toBe(false); // not started
		expect(await saveAttendance(db, 'U_SOMEONE', id, [sam!.id], later(3))).toBe(false);
		expect(await saveAttendance(db, MENTOR.id, id, [sam!.id], later(3))).toBe(true);
		await answerWalk(db, PRIYA.id, id, 'went', later(3));

		expect(await attendedCount(db, SAM.id)).toBe(1);
		expect(await attendedCount(db, PRIYA.id)).toBe(1);
		expect(await attendedCount(db, DEV.id)).toBe(0);
		expect(await walksAwaitingCheckin(db, MENTOR.id, later(3))).toEqual([]);
		expect(await mentorStats(db, MENTOR.id, later(3))).toEqual({
			walksHosted: 1,
			newPeopleTakenOut: 2,
		});
	});
});

describe('campaignMetrics', () => {
	it('matches a hand count', async () => {
		// Two walks that went ahead, 3 + 2 seats; 3 taken; 2 attended; 1 no-show.
		const a = await postWalk({ startsAt: at(-20 * 24), seats: 3 });
		const b = await postWalk({ startsAt: at(-2), seats: 2 });
		const off = await postWalk({ startsAt: at(-30), seats: 4 });
		const longAgo = later(-21 * 24);
		await db.insert(mentorWalkSeats).values([
			{
				walkId: a,
				holderId: SAM.id,
				holderName: SAM.name,
				joinedAt: longAgo.toISOString(),
				wasNew: true,
				mentorTicked: true,
			},
			{
				walkId: a,
				holderId: PRIYA.id,
				holderName: PRIYA.name,
				joinedAt: longAgo.toISOString(),
				wasNew: true,
				answer: 'went',
			},
			{
				walkId: b,
				holderId: DEV.id,
				holderName: DEV.name,
				joinedAt: at(-5),
				wasNew: true,
				answer: 'no-show',
			},
			{ walkId: off, holderId: 'U_X', holderName: 'X', joinedAt: at(-40) },
		]);
		await db.update(mentorWalks).set({ status: 'cancelled' }).where(eq(mentorWalks.id, off));
		// Sam walked his own turf 5 days after walk a; Priya never did.
		await db.insert(vanTurfCheckouts).values({
			turfId: 1,
			slackUserId: SAM.id,
			slackUserName: SAM.name,
			claimedAt: at(-16 * 24),
			expiresAt: at(-14 * 24),
			completedAt: at(-15 * 24),
		});

		expect(await campaignMetrics(db, NOW)).toEqual({
			walksHosted: 2,
			seatsOffered: 5,
			seatsTaken: 3,
			attendanceRate: 2 / 3,
			noShowReports: 1,
			followedOnRate: 1 / 2,
		});
	});
});

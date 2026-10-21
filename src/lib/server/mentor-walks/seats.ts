// Seats on mentor walks (specs/015-mentor-walks, User Stories 3 and 6):
// joining, giving a seat up, and what happened after the walk.
//
// As in store.ts, the rules that must hold under simultaneous requests are in
// the statement itself: a join only lands while the walk has a seat left and
// the joiner holds no overlapping seat (FR-018, FR-019), so two people taking
// the last seat at once can't both get it.

import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import {
	mentors,
	mentorWalkPrompts,
	mentorWalks,
	mentorWalkSeats,
	type MentorWalkSeatRow,
} from '../schema.js';
import {
	CARD_WINDOW_DAYS,
	CHECKIN_DAYS,
	snoozeUntil,
	WALK_HOURS,
} from '../../mentor-walks/rules.js';
import type { Person } from './store.js';

type Db = ReturnType<typeof drizzle>;

const DAY_MS = 86_400_000;
const LOG = '[mentor-walks]';

export type JoinRefusal = 'gone' | 'started' | 'own' | 'full' | 'overlap' | 'already' | 'too-often';

/** Times one person can take a seat on one walk. Every join and every leave
 *  messages the mentor, so this is what stops a join-leave loop spamming them. */
export const MAX_JOINS_PER_WALK = 3;

export type JoinResult = { ok: true; seatId: number } | { ok: false; reason: JoinRefusal };

/**
 * Take a seat. A seat given up earlier is taken again rather than duplicated,
 * and starts over: no answer, no tick. Up to MAX_JOINS_PER_WALK times.
 */
export async function joinWalk(
	db: Db,
	holder: Person,
	walkId: number,
	wasNew: boolean,
	now: Date,
): Promise<JoinResult> {
	const at = now.toISOString();
	const result = await db.run(sql`
		INSERT INTO ${mentorWalkSeats} (walk_id, holder_id, holder_name, joined_at, was_new)
		SELECT w.id, ${holder.id}, ${holder.name}, ${at}, ${wasNew ? 1 : 0}
		FROM ${mentorWalks} w
		WHERE w.id = ${walkId}
		  AND w.status = 'scheduled'
		  AND w.starts_at > ${at}
		  AND w.mentor_id != ${holder.id}
		  AND (SELECT count(*) FROM ${mentorWalkSeats} s
		       WHERE s.walk_id = w.id AND s.left_at IS NULL) < w.seats
		  AND NOT EXISTS (
		    SELECT 1 FROM ${mentorWalkSeats} mine
		    JOIN ${mentorWalks} other ON other.id = mine.walk_id
		    WHERE mine.holder_id = ${holder.id}
		      AND mine.left_at IS NULL
		      AND other.id != w.id
		      AND other.status = 'scheduled'
		      AND abs(julianday(other.starts_at) - julianday(w.starts_at)) * 24 < ${WALK_HOURS}
		  )
		ON CONFLICT (walk_id, holder_id) DO UPDATE SET
		  holder_name = excluded.holder_name,
		  joined_at = excluded.joined_at,
		  was_new = excluded.was_new,
		  left_at = NULL,
		  mentor_ticked = 0,
		  answer = NULL,
		  answered_at = NULL,
		  join_count = ${mentorWalkSeats}.join_count + 1
		WHERE ${mentorWalkSeats}.left_at IS NOT NULL
		  AND ${mentorWalkSeats}.join_count < ${MAX_JOINS_PER_WALK}
	`);
	if (result.rowsAffected > 0) {
		const [seat] = await db
			.select({ id: mentorWalkSeats.id })
			.from(mentorWalkSeats)
			.where(and(eq(mentorWalkSeats.walkId, walkId), eq(mentorWalkSeats.holderId, holder.id)));
		console.log(`${LOG} ${holder.name} (${holder.id}) joined walk ${walkId}`);
		return { ok: true, seatId: seat.id };
	}
	return { ok: false, reason: await whyNotJoined(db, holder.id, walkId, now) };
}

/** Why a join didn't land, for the message. Read after the fact, so it can
 *  in principle name a different reason than the one that applied. */
async function whyNotJoined(
	db: Db,
	holderId: string,
	walkId: number,
	now: Date,
): Promise<JoinRefusal> {
	const [walk] = await db.select().from(mentorWalks).where(eq(mentorWalks.id, walkId));
	if (!walk || walk.status !== 'scheduled') return 'gone';
	if (walk.mentorId === holderId) return 'own';
	if (walk.startsAt <= now.toISOString()) return 'started';
	const seats = await db
		.select({
			holderId: mentorWalkSeats.holderId,
			leftAt: mentorWalkSeats.leftAt,
			joinCount: mentorWalkSeats.joinCount,
		})
		.from(mentorWalkSeats)
		.where(eq(mentorWalkSeats.walkId, walkId));
	const mine = seats.find((s) => s.holderId === holderId);
	if (mine && mine.leftAt === null) return 'already';
	if (mine && mine.joinCount >= MAX_JOINS_PER_WALK) return 'too-often';
	if (seats.filter((s) => s.leftAt === null).length >= walk.seats) return 'full';
	return 'overlap';
}

/** Give a seat up, up to the start (FR-020). The seat, or null when there
 *  was none to give up. */
export async function leaveWalk(
	db: Db,
	holderId: string,
	walkId: number,
	now: Date,
): Promise<MentorWalkSeatRow | null> {
	const at = now.toISOString();
	const [seat] = await db
		.update(mentorWalkSeats)
		.set({ leftAt: at })
		.where(
			and(
				eq(mentorWalkSeats.walkId, walkId),
				eq(mentorWalkSeats.holderId, holderId),
				isNull(mentorWalkSeats.leftAt),
				sql`EXISTS (SELECT 1 FROM ${mentorWalks} w WHERE w.id = ${walkId} AND w.starts_at > ${at})`,
			),
		)
		.returning();
	if (seat) console.log(`${LOG} ${holderId} gave up their seat on walk ${walkId}`);
	return seat ?? null;
}

export type WalkAnswer = 'went' | 'no-show' | 'missed';

/**
 * A seat holder's answer after the walk (FR-030). Only once it has started,
 * and only for a walk that went ahead. They can change it. Returns the answer
 * it replaced, or false when there's no such seat.
 */
export async function answerWalk(
	db: Db,
	holderId: string,
	walkId: number,
	answer: WalkAnswer,
	now: Date,
): Promise<{ previous: WalkAnswer | null } | false> {
	const at = now.toISOString();
	const [before] = await db
		.select({ answer: mentorWalkSeats.answer })
		.from(mentorWalkSeats)
		.where(
			and(
				eq(mentorWalkSeats.walkId, walkId),
				eq(mentorWalkSeats.holderId, holderId),
				isNull(mentorWalkSeats.leftAt),
			),
		);
	if (!before) return false;
	const updated = await db
		.update(mentorWalkSeats)
		.set({ answer, answeredAt: at })
		.where(
			and(
				eq(mentorWalkSeats.walkId, walkId),
				eq(mentorWalkSeats.holderId, holderId),
				isNull(mentorWalkSeats.leftAt),
				sql`EXISTS (SELECT 1 FROM ${mentorWalks} w WHERE w.id = ${walkId}
					AND w.status = 'scheduled' AND w.starts_at <= ${at})`,
			),
		)
		.returning({ id: mentorWalkSeats.id });
	return updated.length > 0 ? { previous: before.answer } : false;
}

/**
 * The mentor's "Who showed up?" (FR-030): ticks exactly the seats given, on
 * their own walk once it has started. False when it isn't theirs to answer.
 */
export async function saveAttendance(
	db: Db,
	mentorId: string,
	walkId: number,
	tickedSeatIds: number[],
	now: Date,
): Promise<boolean> {
	const at = now.toISOString();
	const marked = await db
		.update(mentorWalks)
		.set({ checkedInAt: at })
		.where(
			and(
				eq(mentorWalks.id, walkId),
				eq(mentorWalks.mentorId, mentorId),
				eq(mentorWalks.status, 'scheduled'),
				lte(mentorWalks.startsAt, at),
			),
		)
		.returning({ id: mentorWalks.id });
	if (marked.length === 0) return false;
	await db
		.update(mentorWalkSeats)
		.set({
			mentorTicked:
				tickedSeatIds.length > 0
					? sql`CASE WHEN ${mentorWalkSeats.id} IN (${sql.join(
							tickedSeatIds.map((id) => sql`${id}`),
							sql`, `,
						)}) THEN 1 ELSE 0 END`
					: false,
		})
		.where(and(eq(mentorWalkSeats.walkId, walkId), isNull(mentorWalkSeats.leftAt)));
	console.log(`${LOG} ${mentorId} marked ${tickedSeatIds.length} attendee(s) on walk ${walkId}`);
	return true;
}

/** Free every upcoming seat someone holds, when they're blocked. The seats
 *  given up, so their mentors can be told. */
export async function releaseSeatsOf(
	db: Db,
	holderId: string,
	now: Date,
): Promise<MentorWalkSeatRow[]> {
	const at = now.toISOString();
	return db
		.update(mentorWalkSeats)
		.set({ leftAt: at })
		.where(
			and(
				eq(mentorWalkSeats.holderId, holderId),
				isNull(mentorWalkSeats.leftAt),
				sql`${mentorWalkSeats.walkId} IN (SELECT id FROM ${mentorWalks} WHERE starts_at > ${at})`,
			),
		)
		.returning();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The seats currently held on each of these walks. */
export async function heldSeats(
	db: Db,
	walkIds: number[],
): Promise<Map<number, MentorWalkSeatRow[]>> {
	const byWalk = new Map<number, MentorWalkSeatRow[]>();
	if (walkIds.length === 0) return byWalk;
	const rows = await db
		.select()
		.from(mentorWalkSeats)
		.where(and(inArray(mentorWalkSeats.walkId, walkIds), isNull(mentorWalkSeats.leftAt)))
		.orderBy(mentorWalkSeats.joinedAt);
	for (const row of rows) {
		const list = byWalk.get(row.walkId) ?? [];
		list.push(row);
		byWalk.set(row.walkId, list);
	}
	return byWalk;
}

/** How many walks someone has attended, by the mentor's tick or their own
 *  "I went" (FR-031). */
export async function attendedCount(db: Db, holderId: string): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(mentorWalkSeats)
		.where(
			and(
				eq(mentorWalkSeats.holderId, holderId),
				isNull(mentorWalkSeats.leftAt),
				sql`(${mentorWalkSeats.mentorTicked} = 1 OR ${mentorWalkSeats.answer} = 'went')`,
			),
		);
	return Number(row?.n ?? 0);
}

/**
 * Walks for the cards in one chapter (FR-015): scheduled, starting within
 * CARD_WINDOW_DAYS, not ended, and hosted by a mentor who is still active.
 */
export async function cardWalks(db: Db, chapterId: number, now: Date) {
	const endedBefore = new Date(now.getTime() - WALK_HOURS * 3_600_000).toISOString();
	const until = new Date(now.getTime() + CARD_WINDOW_DAYS * DAY_MS).toISOString();
	return db
		.select({ walk: mentorWalks })
		.from(mentorWalks)
		.innerJoin(mentors, eq(mentors.holderId, mentorWalks.mentorId))
		.where(
			and(
				eq(mentorWalks.chapterId, chapterId),
				eq(mentorWalks.status, 'scheduled'),
				eq(mentors.status, 'active'),
				gt(mentorWalks.startsAt, endedBefore),
				lte(mentorWalks.startsAt, until),
			),
		)
		.orderBy(mentorWalks.startsAt)
		.then((rows) => rows.map((r) => r.walk));
}

/** The seats someone holds on walks that haven't ended, or that ended within
 *  CHECKIN_DAYS — the "your walk" card and the post-walk question — with
 *  their walks. Only walks that went ahead. */
export async function holderSeats(db: Db, holderId: string, now: Date) {
	const since = new Date(now.getTime() - CHECKIN_DAYS * DAY_MS).toISOString();
	return db
		.select({ seat: mentorWalkSeats, walk: mentorWalks })
		.from(mentorWalkSeats)
		.innerJoin(mentorWalks, eq(mentorWalks.id, mentorWalkSeats.walkId))
		.where(
			and(
				eq(mentorWalkSeats.holderId, holderId),
				isNull(mentorWalkSeats.leftAt),
				eq(mentorWalks.status, 'scheduled'),
				gt(mentorWalks.startsAt, since),
			),
		)
		.orderBy(mentorWalks.startsAt);
}

/** A mentor's walks that have started, within CHECKIN_DAYS, with seats held
 *  and no "Who showed up?" saved yet (FR-030). */
export async function walksAwaitingCheckin(db: Db, mentorId: string, now: Date) {
	const at = now.toISOString();
	const since = new Date(now.getTime() - CHECKIN_DAYS * DAY_MS).toISOString();
	return db
		.select()
		.from(mentorWalks)
		.where(
			and(
				eq(mentorWalks.mentorId, mentorId),
				eq(mentorWalks.status, 'scheduled'),
				isNull(mentorWalks.checkedInAt),
				lte(mentorWalks.startsAt, at),
				gt(mentorWalks.startsAt, since),
				sql`EXISTS (SELECT 1 FROM ${mentorWalkSeats} s WHERE s.walk_id = ${mentorWalks.id} AND s.left_at IS NULL)`,
			),
		)
		.orderBy(mentorWalks.startsAt);
}

// ---------------------------------------------------------------------------
// The new-person prompt (FR-014)
// ---------------------------------------------------------------------------

export async function loadPrompt(db: Db, holderId: string) {
	const [row] = await db
		.select()
		.from(mentorWalkPrompts)
		.where(eq(mentorWalkPrompts.holderId, holderId));
	return row ?? null;
}

/** Record the answer: 'accepted' (Yes, or undoing No thanks), 'snoozed' for
 *  SNOOZE_DAYS, or 'declined'. */
export async function setPrompt(
	db: Db,
	holderId: string,
	status: 'accepted' | 'snoozed' | 'declined',
	now: Date,
): Promise<void> {
	const values = {
		status,
		snoozedUntil: status === 'snoozed' ? snoozeUntil(now) : null,
		updatedAt: now.toISOString(),
	};
	await db
		.insert(mentorWalkPrompts)
		.values({ holderId, ...values })
		.onConflictDoUpdate({ target: mentorWalkPrompts.holderId, set: values });
}

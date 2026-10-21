// Who is told what when a mentor walk changes (specs/015-mentor-walks, User
// Stories 5 and 6). Each function queues messages in the outbox (notify.ts)
// under a key naming the event, so calling it twice for the same event queues
// nothing new (FR-026). Sending is the caller's dispatchSoon, or the sweep.

import { and, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { mentors, mentorWalks, mentorWalkSeats, type MentorWalkRow } from '../schema.js';
import { APP_URL } from '../env.js';
import { enqueue, type OutgoingMessage } from './notify.js';
import {
	changedMessage,
	howDidItGoMessage,
	joinedMessage,
	leftMessage,
	mentorCheckinMessage,
	offMessage,
	reminderMessage,
	revokedMessage,
	type WalkFacts,
} from '../../mentor-walks/messages.js';
import { DEFAULT_LOOK_FOR, REMINDER_HOURS } from '../../mentor-walks/rules.js';

type Db = ReturnType<typeof drizzle>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function factsOf(walk: MentorWalkRow): WalkFacts {
	return {
		publicId: walk.publicId,
		chapterId: walk.chapterId,
		mentorName: walk.mentorName,
		startsAt: walk.startsAt,
		place: walk.place,
		note: walk.note,
		lookFor: walk.lookFor ?? DEFAULT_LOOK_FOR,
		phone: walk.phone,
		seats: walk.seats,
	};
}

async function holdersOf(db: Db, walkId: number) {
	return db
		.select({ holderId: mentorWalkSeats.holderId })
		.from(mentorWalkSeats)
		.where(and(eq(mentorWalkSeats.walkId, walkId), isNull(mentorWalkSeats.leftAt)));
}

async function heldCount(db: Db, walkId: number): Promise<number> {
	return (await holdersOf(db, walkId)).length;
}

/** Tell the mentor someone took a seat (FR-023). */
export async function queueJoined(
	db: Db,
	walk: MentorWalkRow,
	seat: { id: number; holderName: string; joinedAt: string },
	now: Date,
): Promise<void> {
	const left = walk.seats - (await heldCount(db, walk.id));
	await enqueue(
		db,
		[
			{
				holderId: walk.mentorId,
				walkId: walk.id,
				eventKey: `join:${seat.id}:${seat.joinedAt}`,
				kind: 'walk-joined',
				text: joinedMessage(factsOf(walk), seat.holderName, left, now),
			},
		],
		now,
	);
}

/** Tell the mentor someone gave their seat up (FR-023). */
export async function queueLeft(
	db: Db,
	walk: MentorWalkRow,
	seat: { id: number; holderName: string; leftAt: string | null },
	now: Date,
): Promise<void> {
	const left = walk.seats - (await heldCount(db, walk.id));
	await enqueue(
		db,
		[
			{
				holderId: walk.mentorId,
				walkId: walk.id,
				eventKey: `leave:${seat.id}:${seat.leftAt ?? now.toISOString()}`,
				kind: 'walk-left',
				text: leftMessage(factsOf(walk), seat.holderName, left, now),
			},
		],
		now,
	);
}

/** Tell everyone holding a seat that the time or place changed (FR-024).
 *  Keyed on the change's time, so each change is told once. */
export async function queueChanged(db: Db, walk: MentorWalkRow, now: Date): Promise<void> {
	const text = changedMessage(factsOf(walk), APP_URL, now);
	await enqueue(
		db,
		(await holdersOf(db, walk.id)).map((h) => ({
			holderId: h.holderId,
			walkId: walk.id,
			eventKey: `changed:${walk.id}:${walk.updatedAt}`,
			kind: 'walk-changed' as const,
			text,
		})),
		now,
	);
}

/** Tell everyone holding a seat that these walks are off, whoever called
 *  them off (FR-024, FR-035, FR-006). */
export async function queueOff(db: Db, walkIds: number[], now: Date): Promise<void> {
	if (walkIds.length === 0) return;
	const walks = await db.select().from(mentorWalks).where(inArray(mentorWalks.id, walkIds));
	const rows: OutgoingMessage[] = [];
	for (const walk of walks) {
		const text = offMessage(factsOf(walk), APP_URL, now);
		for (const h of await holdersOf(db, walk.id)) {
			rows.push({
				holderId: h.holderId,
				walkId: walk.id,
				eventKey: `off:${walk.id}`,
				kind: 'walk-off',
				text,
			});
		}
	}
	await enqueue(db, rows, now);
}

/** Tell a mentor an organizer ended their mentor status. */
export async function queueRevoked(
	db: Db,
	holderId: string,
	revokedAt: string,
	now: Date,
): Promise<void> {
	await enqueue(
		db,
		[
			{
				holderId,
				walkId: null,
				eventKey: `revoked:${revokedAt}`,
				kind: 'mentor-revoked',
				text: revokedMessage(),
			},
		],
		now,
	);
}

/** For the sweep: a reminder to each seat holder on walks starting within
 *  REMINDER_HOURS (FR-025). */
export async function queueReminders(db: Db, now: Date): Promise<void> {
	const at = now.toISOString();
	const soon = new Date(now.getTime() + REMINDER_HOURS * HOUR_MS).toISOString();
	const walks = await db
		.select()
		.from(mentorWalks)
		.where(
			and(
				eq(mentorWalks.status, 'scheduled'),
				gt(mentorWalks.startsAt, at),
				lte(mentorWalks.startsAt, soon),
			),
		);
	const rows: OutgoingMessage[] = [];
	for (const walk of walks) {
		const text = reminderMessage(factsOf(walk), now);
		for (const h of await holdersOf(db, walk.id)) {
			rows.push({
				holderId: h.holderId,
				walkId: walk.id,
				eventKey: `reminder:${walk.id}`,
				kind: 'walk-reminder',
				text,
			});
		}
	}
	await enqueue(db, rows, now);
}

/**
 * For the sweep: once a walk has started, ask the mentor who showed up and
 * each seat holder how it went (FR-030). Only for walks started in the last
 * day, so a sweep that was down doesn't ask about last month.
 */
export async function queueCheckins(db: Db, now: Date): Promise<void> {
	const at = now.toISOString();
	const since = new Date(now.getTime() - DAY_MS).toISOString();
	const walks = await db
		.select()
		.from(mentorWalks)
		.where(
			and(
				eq(mentorWalks.status, 'scheduled'),
				lte(mentorWalks.startsAt, at),
				gt(mentorWalks.startsAt, since),
			),
		);
	// Only a mentor who is still one can answer "Who showed up?": revoking
	// leaves a walk that had already started in place.
	const active = new Set(
		walks.length === 0
			? []
			: (
					await db
						.select({ holderId: mentors.holderId })
						.from(mentors)
						.where(
							and(
								inArray(
									mentors.holderId,
									walks.map((w) => w.mentorId),
								),
								eq(mentors.status, 'active'),
							),
						)
				).map((m) => m.holderId),
	);
	const rows: OutgoingMessage[] = [];
	for (const walk of walks) {
		const holders = await holdersOf(db, walk.id);
		if (holders.length === 0) continue;
		const facts = factsOf(walk);
		if (active.has(walk.mentorId)) {
			rows.push({
				holderId: walk.mentorId,
				walkId: walk.id,
				eventKey: `checkin:${walk.id}`,
				kind: 'walk-checkin',
				text: mentorCheckinMessage(facts, APP_URL, now),
			});
		}
		const howDid = howDidItGoMessage(facts, APP_URL);
		for (const h of holders) {
			rows.push({
				holderId: h.holderId,
				walkId: walk.id,
				eventKey: `howdid:${walk.id}`,
				kind: 'walk-howdid',
				text: howDid,
			});
		}
	}
	await enqueue(db, rows, now);
}

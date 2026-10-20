// The database side of mentor walks (specs/015-mentor-walks): mentor status,
// the walks mentors host, and what organizers see and change.
//
// The rules are pure and live in $lib/mentor-walks/rules.ts. The two that
// must hold under simultaneous requests — no overlapping walks for one mentor
// (FR-009) and no changes once a walk has started (FR-010) — are written into
// the INSERT and UPDATE statements themselves, as claimTurf does for the
// per-volunteer cap, so a double-submitted form can't slip past them.

import { and, asc, desc, eq, gt, isNotNull, lt, lte, ne, notInArray, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { mentors, mentorWalks, vanTurfCheckouts, type MentorRow } from '../schema.js';
import {
	phoneCutoff,
	snoozeUntil,
	WALK_HOURS,
	type MentorStatus,
	type WalkSlot,
} from '../../mentor-walks/rules.js';

type Db = ReturnType<typeof drizzle>;

export interface Person {
	id: string;
	name: string;
}

const LOG = '[mentor-walks]';

// ---------------------------------------------------------------------------
// Mentor status
// ---------------------------------------------------------------------------

export async function loadMentor(db: Db, holderId: string): Promise<MentorRow | null> {
	const [row] = await db.select().from(mentors).where(eq(mentors.holderId, holderId));
	return row ?? null;
}

/**
 * Completed checkouts and doors counted through them, by the same measure as
 * the dashboard (doors-store.ts loadClearedRows), for FR-002.
 */
export async function eligibilityCounts(
	db: Db,
	holderId: string,
): Promise<{ completed: number; doors: number }> {
	const [row] = await db
		.select({
			completed: sql<number>`count(*)`,
			doors: sql<number>`coalesce(sum(coalesce(${vanTurfCheckouts.doorsKnocked}, ${vanTurfCheckouts.confirmedDoorDelta})), 0)`,
		})
		.from(vanTurfCheckouts)
		.where(
			and(eq(vanTurfCheckouts.slackUserId, holderId), isNotNull(vanTurfCheckouts.completedAt)),
		);
	return { completed: Number(row?.completed ?? 0), doors: Number(row?.doors ?? 0) };
}

/**
 * Write a person's status, keeping whatever else the row already says.
 * `unless` lists statuses an existing row must not have, checked in the same
 * statement, so a revoke landing a moment earlier is never written over.
 * False when refused.
 */
async function upsertStatus(
	db: Db,
	person: Person,
	status: MentorStatus,
	now: Date,
	extra: Partial<typeof mentors.$inferInsert>,
	unless: MentorStatus[],
): Promise<boolean> {
	const updatedAt = now.toISOString();
	const set = { holderName: person.name, status, updatedAt, ...extra };
	const written = await db
		.insert(mentors)
		.values({ holderId: person.id, ...set })
		.onConflictDoUpdate({
			target: mentors.holderId,
			set,
			where: notInArray(mentors.status, unless),
		})
		.returning({ holderId: mentors.holderId });
	return written.length > 0;
}

/**
 * The invitation's answer (US1). "Yes" changes nothing yet: someone becomes a
 * mentor by agreeing to the guidelines, which the next screen asks for.
 * A revoked mentor can't answer their way back in, and a mentor can't be
 * snoozed out of it.
 */
export async function answerInvite(
	db: Db,
	person: Person,
	answer: 'snooze' | 'decline',
	now: Date,
): Promise<boolean> {
	const extra = answer === 'snooze' ? { snoozedUntil: snoozeUntil(now) } : { snoozedUntil: null };
	return upsertStatus(db, person, answer === 'snooze' ? 'snoozed' : 'declined', now, extra, [
		'revoked',
		'active',
	]);
}

/**
 * Agree to the guidelines at `url`, the link they were shown, which makes the
 * person an active mentor (FR-005). Refused for a revoked mentor: only an
 * organizer reinstates.
 */
export async function agreeToGuidelines(
	db: Db,
	person: Person,
	url: string,
	now: Date,
): Promise<boolean> {
	const ok = await upsertStatus(
		db,
		person,
		'active',
		now,
		{ snoozedUntil: null, agreedAt: now.toISOString(), agreedUrl: url },
		['revoked'],
	);
	if (ok) console.log(`${LOG} ${person.name} (${person.id}) agreed to the guidelines`);
	return ok;
}

/**
 * An organizer makes someone a mentor (FR-006). They still agree before
 * hosting. Refused for anyone already active or revoked — a revoked mentor is
 * reinstated instead.
 */
export async function appointMentor(
	db: Db,
	person: Person,
	editor: Person,
	now: Date,
): Promise<boolean> {
	const ok = await upsertStatus(
		db,
		person,
		'active',
		now,
		{
			snoozedUntil: null,
			appointedBy: editor.id,
			appointedByName: editor.name,
			revokedBy: null,
			revokedByName: null,
			revokedAt: null,
		},
		['active', 'revoked'],
	);
	if (ok) console.log(`${LOG} ${editor.name} made ${person.name} (${person.id}) a mentor`);
	return ok;
}

/**
 * Revoke a mentor and cancel their upcoming walks (FR-006). Also how blocking
 * an active mentor takes effect. Returns the walks cancelled.
 */
export async function revokeMentor(
	db: Db,
	holderId: string,
	editor: Person,
	now: Date,
): Promise<number[]> {
	const updated = await db
		.update(mentors)
		.set({
			status: 'revoked',
			snoozedUntil: null,
			revokedBy: editor.id,
			revokedByName: editor.name,
			revokedAt: now.toISOString(),
			updatedAt: now.toISOString(),
		})
		.where(eq(mentors.holderId, holderId))
		.returning({ name: mentors.holderName });
	if (updated.length === 0) return [];
	const cancelled = await db
		.update(mentorWalks)
		.set({
			status: 'cancelled',
			statusBy: editor.id,
			statusByName: editor.name,
			updatedAt: now.toISOString(),
		})
		.where(
			and(
				eq(mentorWalks.mentorId, holderId),
				eq(mentorWalks.status, 'scheduled'),
				gt(mentorWalks.startsAt, now.toISOString()),
			),
		)
		.returning({ id: mentorWalks.id });
	// US5: tell everyone holding a seat on `cancelled` that the walk is off.
	console.log(
		`${LOG} ${editor.name} revoked ${updated[0].name} (${holderId}); cancelled ${cancelled.length} walk(s)`,
	);
	return cancelled.map((w) => w.id);
}

/** Undo a revoke. Their earlier agreement stands unless the link has changed. */
export async function reinstateMentor(
	db: Db,
	holderId: string,
	editor: Person,
	now: Date,
): Promise<boolean> {
	const updated = await db
		.update(mentors)
		.set({
			status: 'active',
			revokedBy: null,
			revokedByName: null,
			revokedAt: null,
			updatedAt: now.toISOString(),
		})
		.where(and(eq(mentors.holderId, holderId), eq(mentors.status, 'revoked')))
		.returning({ name: mentors.holderName });
	if (updated.length > 0) {
		console.log(`${LOG} ${editor.name} reinstated ${updated[0].name} (${holderId})`);
	}
	return updated.length > 0;
}

/**
 * Forget someone's mentor status, as if never invited, and call off their
 * upcoming walks. Only for an admin starting a simulation over on themselves.
 */
export async function forgetMentor(db: Db, person: Person, now: Date): Promise<void> {
	await db
		.update(mentorWalks)
		.set({
			status: 'cancelled',
			statusBy: person.id,
			statusByName: person.name,
			updatedAt: now.toISOString(),
		})
		.where(
			and(
				eq(mentorWalks.mentorId, person.id),
				eq(mentorWalks.status, 'scheduled'),
				gt(mentorWalks.startsAt, now.toISOString()),
			),
		);
	await db.delete(mentors).where(eq(mentors.holderId, person.id));
	console.log(`${LOG} ${person.name} (${person.id}) reset their own mentor status`);
}

/** Everyone with a mentor row who is or was a mentor, for the organizer view. */
export async function listMentors(db: Db): Promise<MentorRow[]> {
	return db
		.select()
		.from(mentors)
		.where(sql`${mentors.status} IN ('active', 'revoked')`)
		.orderBy(asc(mentors.holderName));
}

// ---------------------------------------------------------------------------
// Walks
// ---------------------------------------------------------------------------

export interface WalkFields {
	chapterId: number;
	startsAt: string;
	place: string;
	lat: number;
	lng: number;
	/** '' for none. */
	note: string;
	seats: number;
	/** '' for none. */
	phone: string;
}

/** SQL: another scheduled walk of this mentor's within WALK_HOURS of `startsAt`. */
function overlapping(mentorId: string, startsAt: string, exceptId: number) {
	return sql`EXISTS (
		SELECT 1 FROM ${mentorWalks} other
		WHERE other.mentor_id = ${mentorId}
		  AND other.status = 'scheduled'
		  AND other.id != ${exceptId}
		  AND abs(julianday(other.starts_at) - julianday(${startsAt})) * 24 < ${WALK_HOURS}
	)`;
}

export type WalkWriteResult = { ok: true; id: number } | { ok: false; message: string };

const OVERLAP_MESSAGE = `You already have a walk within ${WALK_HOURS} hours of that time.`;

export async function createWalk(
	db: Db,
	mentor: Person,
	fields: WalkFields,
	now: Date,
): Promise<WalkWriteResult> {
	const at = now.toISOString();
	const result = await db.run(sql`
		INSERT INTO ${mentorWalks}
			(mentor_id, mentor_name, chapter_id, starts_at, place, lat, lng, note, seats, phone,
			 status, created_at, updated_at)
		SELECT ${mentor.id}, ${mentor.name}, ${fields.chapterId}, ${fields.startsAt}, ${fields.place},
			${fields.lat}, ${fields.lng}, ${fields.note || null}, ${fields.seats}, ${fields.phone || null},
			'scheduled', ${at}, ${at}
		WHERE NOT ${overlapping(mentor.id, fields.startsAt, -1)}
	`);
	if (result.rowsAffected === 0) return { ok: false, message: OVERLAP_MESSAGE };
	const id = Number(result.lastInsertRowid);
	console.log(`${LOG} ${mentor.name} (${mentor.id}) posted walk ${id} for ${fields.startsAt}`);
	return { ok: true, id };
}

/** Change a walk the mentor owns, up to its start (FR-010). */
export async function updateWalk(
	db: Db,
	mentorId: string,
	walkId: number,
	fields: WalkFields,
	now: Date,
): Promise<WalkWriteResult> {
	const updated = await db
		.update(mentorWalks)
		.set({
			chapterId: fields.chapterId,
			startsAt: fields.startsAt,
			place: fields.place,
			lat: fields.lat,
			lng: fields.lng,
			note: fields.note || null,
			seats: fields.seats,
			phone: fields.phone || null,
			updatedAt: now.toISOString(),
		})
		.where(
			and(
				eq(mentorWalks.id, walkId),
				eq(mentorWalks.mentorId, mentorId),
				eq(mentorWalks.status, 'scheduled'),
				gt(mentorWalks.startsAt, now.toISOString()),
				sql`NOT ${overlapping(mentorId, fields.startsAt, walkId)}`,
			),
		)
		.returning({ id: mentorWalks.id });
	if (updated.length > 0) {
		// US5: tell seat holders when the time or place changed.
		return { ok: true, id: walkId };
	}
	const [walk] = await db
		.select({ startsAt: mentorWalks.startsAt, status: mentorWalks.status })
		.from(mentorWalks)
		.where(and(eq(mentorWalks.id, walkId), eq(mentorWalks.mentorId, mentorId)));
	if (!walk || walk.status !== 'scheduled') {
		return { ok: false, message: 'That walk was cancelled.' };
	}
	if (walk.startsAt <= now.toISOString()) {
		return { ok: false, message: 'That walk has already started, so it can’t be changed.' };
	}
	return { ok: false, message: OVERLAP_MESSAGE };
}

/** The mentor calls their walk off, up to its start (FR-010). */
export async function cancelWalk(
	db: Db,
	mentor: Person,
	walkId: number,
	now: Date,
): Promise<boolean> {
	const updated = await db
		.update(mentorWalks)
		.set({
			status: 'cancelled',
			statusBy: mentor.id,
			statusByName: mentor.name,
			updatedAt: now.toISOString(),
		})
		.where(
			and(
				eq(mentorWalks.id, walkId),
				eq(mentorWalks.mentorId, mentor.id),
				eq(mentorWalks.status, 'scheduled'),
				gt(mentorWalks.startsAt, now.toISOString()),
			),
		)
		.returning({ id: mentorWalks.id });
	// US5: tell seat holders the walk is off.
	return updated.length > 0;
}

/** A mentor's scheduled walks that haven't started, soonest first. */
export async function listMentorWalks(db: Db, mentorId: string, now: Date) {
	return db
		.select()
		.from(mentorWalks)
		.where(
			and(
				eq(mentorWalks.mentorId, mentorId),
				eq(mentorWalks.status, 'scheduled'),
				gt(mentorWalks.startsAt, now.toISOString()),
			),
		)
		.orderBy(asc(mentorWalks.startsAt));
}

/** The mentor's other live walks, for validateWalk's friendly overlap check. */
export async function mentorWalkSlots(
	db: Db,
	mentorId: string,
	exceptId: number | null,
): Promise<WalkSlot[]> {
	return db
		.select({ id: mentorWalks.id, startsAt: mentorWalks.startsAt })
		.from(mentorWalks)
		.where(
			and(
				eq(mentorWalks.mentorId, mentorId),
				eq(mentorWalks.status, 'scheduled'),
				ne(mentorWalks.id, exceptId ?? -1),
			),
		);
}

/** Walks hosted: scheduled walks whose start has passed (FR-033). */
export async function mentorStats(
	db: Db,
	mentorId: string,
	now: Date,
): Promise<{ walksHosted: number; newPeopleTakenOut: number }> {
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(mentorWalks)
		.where(
			and(
				eq(mentorWalks.mentorId, mentorId),
				eq(mentorWalks.status, 'scheduled'),
				lte(mentorWalks.startsAt, now.toISOString()),
			),
		);
	// US6: count attendees once attendance is recorded.
	return { walksHosted: Number(row?.n ?? 0), newPeopleTakenOut: 0 };
}

/** The number from the mentor's most recent walk that still has one (FR-012). */
export async function latestPhone(db: Db, mentorId: string): Promise<string> {
	const [row] = await db
		.select({ phone: mentorWalks.phone })
		.from(mentorWalks)
		.where(and(eq(mentorWalks.mentorId, mentorId), isNotNull(mentorWalks.phone)))
		.orderBy(desc(mentorWalks.createdAt))
		.limit(1);
	return row?.phone ?? '';
}

export async function loadWalk(db: Db, walkId: number) {
	const [row] = await db.select().from(mentorWalks).where(eq(mentorWalks.id, walkId));
	return row ?? null;
}

// ---------------------------------------------------------------------------
// Organizers
// ---------------------------------------------------------------------------

/** How far back the organizer view lists past walks. */
export const PAST_WALK_DAYS = 30;

/** Upcoming walks soonest first, and past ones from the last PAST_WALK_DAYS,
 *  newest first — every status, so organizers see what was cancelled. */
export async function listWalksForOrganizer(db: Db, now: Date) {
	const at = now.toISOString();
	const since = new Date(now.getTime() - PAST_WALK_DAYS * 86_400_000).toISOString();
	const [upcoming, past] = await Promise.all([
		db
			.select()
			.from(mentorWalks)
			.where(gt(mentorWalks.startsAt, at))
			.orderBy(asc(mentorWalks.startsAt)),
		db
			.select()
			.from(mentorWalks)
			.where(and(lte(mentorWalks.startsAt, at), gt(mentorWalks.startsAt, since)))
			.orderBy(desc(mentorWalks.startsAt)),
	]);
	return { upcoming, past };
}

/** Per mentor: walks hosted (started and not called off), and the chapter
 *  of their latest walk of any kind, for the organizer's mentor list. */
export async function mentorTotals(
	db: Db,
	now: Date,
): Promise<Map<string, { walksHosted: number; lastChapterId: number | null }>> {
	const rows = await db
		.select({
			mentorId: mentorWalks.mentorId,
			walksHosted: sql<number>`sum(CASE WHEN ${mentorWalks.status} = 'scheduled' AND ${mentorWalks.startsAt} <= ${now.toISOString()} THEN 1 ELSE 0 END)`,
			// SQLite's bare column in a max() aggregate comes from the max row.
			lastStartsAt: sql<string>`max(${mentorWalks.startsAt})`,
			lastChapterId: mentorWalks.chapterId,
		})
		.from(mentorWalks)
		.groupBy(mentorWalks.mentorId);
	return new Map(
		rows.map((r) => [
			r.mentorId,
			{ walksHosted: Number(r.walksHosted ?? 0), lastChapterId: r.lastChapterId ?? null },
		]),
	);
}

/** An organizer hides or cancels a walk that hasn't started (FR-035). */
export async function setWalkStatus(
	db: Db,
	walkId: number,
	status: 'hidden' | 'cancelled',
	editor: Person,
	now: Date,
): Promise<boolean> {
	const updated = await db
		.update(mentorWalks)
		.set({ status, statusBy: editor.id, statusByName: editor.name, updatedAt: now.toISOString() })
		.where(
			and(
				eq(mentorWalks.id, walkId),
				eq(mentorWalks.status, 'scheduled'),
				gt(mentorWalks.startsAt, now.toISOString()),
			),
		)
		.returning({ id: mentorWalks.id });
	if (updated.length > 0) {
		// US5: tell seat holders the walk is off.
		console.log(`${LOG} ${editor.name} set walk ${walkId} to ${status}`);
	}
	return updated.length > 0;
}

/** Delete phone numbers a day after their walk's start (FR-011). */
export async function purgeExpiredPhones(db: Db, now: Date): Promise<number> {
	const cleared = await db
		.update(mentorWalks)
		.set({ phone: null })
		.where(and(isNotNull(mentorWalks.phone), lt(mentorWalks.startsAt, phoneCutoff(now))))
		.returning({ id: mentorWalks.id });
	if (cleared.length > 0) console.log(`${LOG} deleted ${cleared.length} phone number(s)`);
	return cleared.length;
}

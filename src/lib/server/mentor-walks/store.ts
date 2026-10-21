// The database side of mentor walks (specs/015-mentor-walks): mentor status,
// the walks mentors host, and what organizers see and change.
//
// The rules are pure and live in $lib/mentor-walks/rules.ts. The two that
// must hold under simultaneous requests — no overlapping walks for one mentor
// (FR-009) and no changes once a walk has started (FR-010) — are written into
// the INSERT and UPDATE statements themselves, as claimTurf does for the
// per-volunteer cap, so a double-submitted form can't slip past them.

import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	lt,
	lte,
	ne,
	notInArray,
	sql,
} from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { drizzle } from 'drizzle-orm/libsql';
import {
	mentors,
	mentorWalks,
	mentorWalkMessages,
	mentorWalkSeats,
	turfNotices,
	vanTurfCheckouts,
	type MentorRow,
} from '../schema.js';
import { queueChanged, queueOff, queueRevoked } from './walk-events.js';
import {
	DEFAULT_LOOK_FOR,
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

/** Whether someone has ever checked out a turf, finished or not. */
export async function hasCheckedOutTurf(db: Db, holderId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: vanTurfCheckouts.id })
		.from(vanTurfCheckouts)
		.where(eq(vanTurfCheckouts.slackUserId, holderId))
		.limit(1);
	return row !== undefined;
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
	await queueOff(
		db,
		cancelled.map((w) => w.id),
		now,
	);
	await queueRevoked(db, holderId, now.toISOString(), now);
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
	const cancelled = await db
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
		)
		.returning({ id: mentorWalks.id });
	await queueOff(
		db,
		cancelled.map((w) => w.id),
		now,
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
	/** How new people spot them: "Campaign merch". */
	lookFor: string;
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

export type WalkWriteResult =
	| {
			ok: true;
			id: number;
			publicId: string;
			/** The time or place changed. */
			changed?: boolean;
	  }
	| { ok: false; message: string };

/** A walk's public id: 72 random bits, 12 URL-safe characters. */
export function newPublicId(): string {
	return randomBytes(9).toString('base64url');
}

/** What a public id can look like: these, or the hex ones migration 0077
 *  gave walks posted before. Anything else is never looked up. */
const PUBLIC_ID = /^[\w-]{12,24}$/;

/** The walk a public id names, or null. */
export async function loadWalkByPublicId(db: Db, publicId: string) {
	if (!PUBLIC_ID.test(publicId)) return null;
	const [row] = await db.select().from(mentorWalks).where(eq(mentorWalks.publicId, publicId));
	return row ?? null;
}

/** SQL: the seats held on this walk. */
function seatsHeld(walkId: number) {
	return sql`(SELECT count(*) FROM ${mentorWalkSeats} s WHERE s.walk_id = ${walkId} AND s.left_at IS NULL)`;
}

const OVERLAP_MESSAGE = `You already have a walk within ${WALK_HOURS} hours of that time.`;

export async function createWalk(
	db: Db,
	mentor: Person,
	fields: WalkFields,
	now: Date,
): Promise<WalkWriteResult> {
	const at = now.toISOString();
	const publicId = newPublicId();
	const result = await db.run(sql`
		INSERT INTO ${mentorWalks}
			(public_id, mentor_id, mentor_name, chapter_id, starts_at, place, lat, lng, note, look_for, seats,
			 phone, status, created_at, updated_at)
		SELECT ${publicId}, ${mentor.id}, ${mentor.name}, ${fields.chapterId}, ${fields.startsAt}, ${fields.place},
			${fields.lat}, ${fields.lng}, ${fields.note || null}, ${fields.lookFor}, ${fields.seats},
			${fields.phone || null},
			'scheduled', ${at}, ${at}
		WHERE NOT ${overlapping(mentor.id, fields.startsAt, -1)}
	`);
	if (result.rowsAffected === 0) return { ok: false, message: OVERLAP_MESSAGE };
	const id = Number(result.lastInsertRowid);
	console.log(`${LOG} ${mentor.name} (${mentor.id}) posted walk ${id} for ${fields.startsAt}`);
	return { ok: true, id, publicId };
}

/**
 * Change a walk the mentor owns, up to its start (FR-010), never below the
 * seats already taken (FR-009). The people holding seats are told when the
 * time or place changed (FR-024).
 */
export async function updateWalk(
	db: Db,
	mentorId: string,
	walkId: number,
	fields: WalkFields,
	now: Date,
): Promise<WalkWriteResult> {
	const before = await loadWalk(db, walkId);
	const [updated] = await db
		.update(mentorWalks)
		.set({
			chapterId: fields.chapterId,
			startsAt: fields.startsAt,
			place: fields.place,
			lat: fields.lat,
			lng: fields.lng,
			note: fields.note || null,
			lookFor: fields.lookFor,
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
				sql`${fields.seats} >= ${seatsHeld(walkId)}`,
			),
		)
		.returning();
	if (updated) {
		const changed =
			before !== null && (before.startsAt !== updated.startsAt || before.place !== updated.place);
		if (changed) await queueChanged(db, updated, now);
		return { ok: true, id: walkId, publicId: updated.publicId, changed };
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
	const [held] = await db
		.select({ n: seatsHeld(walkId) })
		.from(mentorWalks)
		.limit(1);
	const taken = Number(held?.n ?? 0);
	if (fields.seats < taken) {
		return {
			ok: false,
			message: `${taken} ${taken === 1 ? 'person has' : 'people have'} already joined, so you need at least ${taken} seats.`,
		};
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
	await queueOff(
		db,
		updated.map((w) => w.id),
		now,
	);
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

/** SQL: a held seat whose holder attended, by the mentor's tick or their own
 *  "I went" (FR-031). For a seat aliased `s`. */
const ATTENDED = sql.raw(`s.left_at IS NULL AND (s.mentor_ticked = 1 OR s.answer = 'went')`);

/** Walks hosted: scheduled walks whose start has passed. New people taken
 *  out: people who were new when they joined one and attended (FR-033). */
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
	const [people] = await db.all<{ n: number }>(sql`
		SELECT count(DISTINCT s.holder_id) AS n
		FROM ${mentorWalkSeats} s JOIN ${mentorWalks} w ON w.id = s.walk_id
		WHERE w.mentor_id = ${mentorId} AND s.was_new = 1 AND ${ATTENDED}
	`);
	return { walksHosted: Number(row?.n ?? 0), newPeopleTakenOut: Number(people?.n ?? 0) };
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

/** How the mentor said to spot them on their latest walk, for the next
 *  walk's form; campaign merch before they've said. */
export async function latestLookFor(db: Db, mentorId: string): Promise<string> {
	const [row] = await db
		.select({ lookFor: mentorWalks.lookFor })
		.from(mentorWalks)
		.where(and(eq(mentorWalks.mentorId, mentorId), isNotNull(mentorWalks.lookFor)))
		.orderBy(desc(mentorWalks.createdAt))
		.limit(1);
	return row?.lookFor ?? DEFAULT_LOOK_FOR;
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

/** Per mentor: walks hosted (started and not called off), new people taken
 *  out, and the chapter of their latest walk of any kind, for the
 *  organizer's mentor list. */
export async function mentorTotals(
	db: Db,
	now: Date,
): Promise<
	Map<string, { walksHosted: number; newPeopleTakenOut: number; lastChapterId: number | null }>
> {
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
	const people = await db.all<{ mentorId: string; n: number }>(sql`
		SELECT w.mentor_id AS mentorId, count(DISTINCT s.holder_id) AS n
		FROM ${mentorWalkSeats} s JOIN ${mentorWalks} w ON w.id = s.walk_id
		WHERE s.was_new = 1 AND ${ATTENDED}
		GROUP BY w.mentor_id
	`);
	const taken = new Map(people.map((p) => [p.mentorId, Number(p.n)]));
	return new Map(
		rows.map((r) => [
			r.mentorId,
			{
				walksHosted: Number(r.walksHosted ?? 0),
				newPeopleTakenOut: taken.get(r.mentorId) ?? 0,
				lastChapterId: r.lastChapterId ?? null,
			},
		]),
	);
}

/** Days after a walk in which an attendee's own completed turf counts as
 *  "went on to canvass" (FR-037, SC-003). */
export const FOLLOW_ON_DAYS = 14;

export interface CampaignMetrics {
	walksHosted: number;
	seatsOffered: number;
	seatsTaken: number;
	/** Attended out of seats taken, on walks that have started; null before any. */
	attendanceRate: number | null;
	noShowReports: number;
	/** Attendees who completed their own turf within FOLLOW_ON_DAYS of the
	 *  walk, out of attendees whose walk was at least that long ago; null
	 *  before there are any. */
	followedOnRate: number | null;
}

/** The organizer's headline numbers (FR-037), over every walk that went
 *  ahead — scheduled, not cancelled or hidden — and has started. */
export async function campaignMetrics(db: Db, now: Date): Promise<CampaignMetrics> {
	const at = now.toISOString();
	const [walks] = await db.all<{ hosted: number; offered: number }>(sql`
		SELECT count(*) AS hosted, coalesce(sum(seats), 0) AS offered
		FROM ${mentorWalks} WHERE status = 'scheduled' AND starts_at <= ${at}
	`);
	const [seats] = await db.all<{ taken: number; attended: number; noShows: number }>(sql`
		SELECT
			coalesce(sum(CASE WHEN s.left_at IS NULL THEN 1 ELSE 0 END), 0) AS taken,
			coalesce(sum(CASE WHEN ${ATTENDED} THEN 1 ELSE 0 END), 0) AS attended,
			coalesce(sum(CASE WHEN s.left_at IS NULL AND s.answer = 'no-show' THEN 1 ELSE 0 END), 0) AS noShows
		FROM ${mentorWalkSeats} s JOIN ${mentorWalks} w ON w.id = s.walk_id
		WHERE w.status = 'scheduled' AND w.starts_at <= ${at}
	`);
	// Only walks at least FOLLOW_ON_DAYS old: a walk last week hasn't had its
	// chance yet, and counting it would drag the rate down.
	const matured = new Date(now.getTime() - FOLLOW_ON_DAYS * 86_400_000).toISOString();
	const [follow] = await db.all<{ attendees: number; walked: number }>(sql`
		SELECT count(*) AS attendees,
			coalesce(sum(CASE WHEN EXISTS (
				SELECT 1 FROM ${vanTurfCheckouts} c
				WHERE c.slack_user_id = s.holder_id
				  AND c.completed_at IS NOT NULL
				  AND c.completed_at > w.starts_at
				  AND julianday(c.completed_at) - julianday(w.starts_at) <= ${FOLLOW_ON_DAYS}
			) THEN 1 ELSE 0 END), 0) AS walked
		FROM ${mentorWalkSeats} s JOIN ${mentorWalks} w ON w.id = s.walk_id
		WHERE w.status = 'scheduled' AND w.starts_at <= ${matured} AND ${ATTENDED}
	`);
	const taken = Number(seats?.taken ?? 0);
	const attendees = Number(follow?.attendees ?? 0);
	return {
		walksHosted: Number(walks?.hosted ?? 0),
		seatsOffered: Number(walks?.offered ?? 0),
		seatsTaken: taken,
		attendanceRate: taken > 0 ? Number(seats?.attended ?? 0) / taken : null,
		noShowReports: Number(seats?.noShows ?? 0),
		followedOnRate: attendees > 0 ? Number(follow?.walked ?? 0) / attendees : null,
	};
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
		await queueOff(db, [walkId], now);
		console.log(`${LOG} ${editor.name} set walk ${walkId} to ${status}`);
	}
	return updated.length > 0;
}

/**
 * Delete phone numbers a day after their walk's start (FR-011, SC-008). The
 * reminder carries the number too, so its text goes from the outbox, and a
 * Google or Apple volunteer's copy of it from their notices. A reminder is
 * never sent once its walk has started (dispatchPending), so one stored more
 * than a day ago is always for a walk that started more than a day ago.
 */
export async function purgeExpiredPhones(db: Db, now: Date): Promise<number> {
	const cutoff = phoneCutoff(now);
	const cleared = await db
		.update(mentorWalks)
		.set({ phone: null })
		.where(and(isNotNull(mentorWalks.phone), lt(mentorWalks.startsAt, cutoff)))
		.returning({ id: mentorWalks.id });
	if (cleared.length > 0) console.log(`${LOG} deleted ${cleared.length} phone number(s)`);
	await db
		.update(mentorWalkMessages)
		.set({
			text: '',
			status: sql`CASE WHEN ${mentorWalkMessages.status} = 'sent' THEN 'sent' ELSE 'skipped' END`,
		})
		.where(
			and(
				eq(mentorWalkMessages.kind, 'walk-reminder'),
				ne(mentorWalkMessages.text, ''),
				inArray(
					mentorWalkMessages.walkId,
					db
						.select({ id: mentorWalks.id })
						.from(mentorWalks)
						.where(lt(mentorWalks.startsAt, cutoff)),
				),
			),
		);
	await db
		.delete(turfNotices)
		.where(and(eq(turfNotices.kind, 'walk-reminder'), lt(turfNotices.createdAt, cutoff)));
	return cleared.length;
}

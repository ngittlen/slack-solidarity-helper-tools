// Telling a turf holder something, whichever way they signed in.
//
// The turf sweeps used to DM every holder through sendDm. A Google volunteer
// has no Slack, so notifyHolder writes the same message to `turf_notices`
// instead, and /turfs shows it (specs/013-google-sso-login, User Story 5).
// Same boolean contract as sendDm — true when the message is delivered or
// stored — so the sweeps keep their stamp-on-success, retry-on-failure logic
// unchanged for both kinds of holder.

import { and, desc, eq, gte, lt } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { turfNotices } from '../schema.js';
import { isGoogleUserId } from '../identity.js';
import { sendDm } from '../slack-dm.js';
import { errMessage } from '../../err-message.js';

type Database = ReturnType<typeof drizzle>;

export type HolderNoticeKind = 'expiry' | 'unsynced' | 'list-number' | 'walked-out' | 'recut';

/** How long an undismissed notice stays on /turfs. Every message here is
 *  about a claim measured in hours or days; past a week it is history. */
export const NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface HolderNotice {
	id: number;
	kind: string;
	text: string;
	createdAt: string;
}

/**
 * DM a Slack holder, or keep the message for a Google holder's next visit to
 * /turfs. Never throws.
 */
export async function notifyHolder(
	db: Database,
	holderId: string,
	kind: HolderNoticeKind,
	text: string,
	logTag: string,
	now: Date = new Date(),
): Promise<boolean> {
	if (!isGoogleUserId(holderId)) return sendDm(holderId, text, logTag);
	try {
		await db
			.insert(turfNotices)
			.values({ userId: holderId, kind, text, createdAt: now.toISOString() });
		return true;
	} catch (err) {
		console.error(`${logTag} could not store a ${kind} notice for ${holderId}:`, errMessage(err));
		return false;
	}
}

/**
 * A holder's notices, newest first, leaving out any past NOTICE_MAX_AGE_MS.
 * Read-only — pruneHolderNotices does the deleting, on the sync's schedule,
 * so a page load never writes. Throws on a failed read; the caller decides
 * what a page does then.
 */
export async function loadHolderNotices(
	db: Database,
	holderId: string,
	now: Date = new Date(),
): Promise<HolderNotice[]> {
	const cutoff = new Date(now.getTime() - NOTICE_MAX_AGE_MS).toISOString();
	return db
		.select({
			id: turfNotices.id,
			kind: turfNotices.kind,
			text: turfNotices.text,
			createdAt: turfNotices.createdAt,
		})
		.from(turfNotices)
		.where(and(eq(turfNotices.userId, holderId), gte(turfNotices.createdAt, cutoff)))
		.orderBy(desc(turfNotices.createdAt), desc(turfNotices.id));
}

/**
 * Delete every notice past NOTICE_MAX_AGE_MS, whoever it belongs to — read or
 * not. Run by the sync's housekeeping, so the week-at-most promise in
 * PRIVACY.md holds for a volunteer who never comes back, or who was blocked
 * and so is never shown theirs. Returns how many went.
 */
export async function pruneHolderNotices(db: Database, now: Date = new Date()): Promise<number> {
	const cutoff = new Date(now.getTime() - NOTICE_MAX_AGE_MS).toISOString();
	const gone = await db
		.delete(turfNotices)
		.where(lt(turfNotices.createdAt, cutoff))
		.returning({ id: turfNotices.id });
	return gone.length;
}

/** Dismiss (delete) one notice — only ever the holder's own. */
export async function dismissHolderNotice(
	db: Database,
	holderId: string,
	noticeId: number,
): Promise<void> {
	await db
		.delete(turfNotices)
		.where(and(eq(turfNotices.id, noticeId), eq(turfNotices.userId, holderId)));
}

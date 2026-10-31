// Telling a turf holder something, whichever way they signed in.
//
// The turf sweeps used to DM every holder through sendDm. A Google or Apple
// volunteer has no Slack, so notifyHolder writes the same message to `turf_notices`
// instead, and /turfs shows it (specs/013-google-sso-login, User Story 5).
// Same boolean contract as sendDm — true when the message is delivered or
// stored — so the sweeps keep their stamp-on-success, retry-on-failure logic
// unchanged for both kinds of holder.
//
// A holder who turned on push notifications (the header's bell) gets a push first
// (push.ts). For a Slack holder it replaces the DM; the DM goes only if no
// device took the push. A Google or Apple holder's notice is still kept for
// the page, where the push opens it. A push-only notice (PUSH_ONLY) whose
// every device failed reports undelivered, so the sweep retries it as it
// does a failed DM; one for a holder with no devices is simply done.

import { and, desc, eq, gte, lt } from 'drizzle-orm';
import type { KnownBlock } from '@slack/web-api';
import type { drizzle } from 'drizzle-orm/libsql';
import { turfNotices } from '../schema.js';
import { isOutsideUserId } from '../identity.js';
import { sendDm } from '../slack-dm.js';
import { APP_URL } from '../env.js';
import { sendPush } from '../push.js';
import { errMessage } from '../../err-message.js';
import { noticePushText } from '../../van/notice-text.js';
import { WALK_MESSAGE_TITLES, type WalkMessageKind } from '../../mentor-walks/messages.js';

type Database = ReturnType<typeof drizzle>;

export type HolderNoticeKind =
	| 'expiry'
	| 'unsynced'
	| 'list-number'
	| 'walked-out'
	| 'recut'
	| 'lapsed'
	| 'doors-counted'
	// Mentor walks (specs/015-mentor-walks, User Story 5), sent the same ways.
	| WalkMessageKind;

/** The notification's title; the message itself is its body. */
const PUSH_TITLES: Record<HolderNoticeKind, string> = {
	...WALK_MESSAGE_TITLES,
	expiry: 'Your turf expires soon',
	unsynced: "VAN doesn't have your doors yet",
	'list-number': 'Your list number changed',
	'walked-out': 'Your turf is done',
	recut: 'Your turf was re-cut',
	lapsed: 'Your turf claim ended',
	'doors-counted': 'VAN has your doors',
};

/** Notices that arrived with push and have never been Slack DMs. A Slack
 *  holder without push gets nothing for these, as before they existed. */
const PUSH_ONLY: ReadonlySet<HolderNoticeKind> = new Set(['lapsed', 'doors-counted']);

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
 * Push to a holder's devices, if they opted in. Then DM a Slack holder no
 * device reached, or keep the message for a Google or Apple holder's next
 * visit to /turfs. Never throws.
 */
export async function notifyHolder(
	db: Database,
	holderId: string,
	kind: HolderNoticeKind,
	text: string,
	logTag: string,
	now: Date = new Date(),
	/** Blocks after a Slack DM's message, such as a button. */
	slackBlocks: readonly KnownBlock[] = [],
): Promise<boolean> {
	const { body, url } = noticePushText(text, APP_URL);
	const push = await sendPush(
		db,
		holderId,
		{ title: PUSH_TITLES[kind], body, url, tag: kind },
		{ now },
	);
	if (!isOutsideUserId(holderId)) {
		if (push === 'sent') return true;
		if (PUSH_ONLY.has(kind)) return push === 'no-devices';
		return sendDm(holderId, text, logTag, slackBlocks);
	}
	try {
		await db
			.insert(turfNotices)
			.values({ userId: holderId, kind, text, createdAt: now.toISOString() });
		return true;
	} catch (err) {
		console.error(`${logTag} could not store a ${kind} notice for ${holderId}:`, errMessage(err));
		return push === 'sent';
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

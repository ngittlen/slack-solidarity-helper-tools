// Telling a holder their claim lapsed, and that VAN has their doors.
//
// Both are scans of the ledger rather than hooks on the code that changes
// it: a claim lapses in sweepExpiredClaims or, read lazily, inside another
// volunteer's claimTurf; doors are counted by the scheduled contact pull. A
// scan catches all of them, and a stamp per checkout means each is said once
// — stamped only when notifyHolder reports it delivered, so a failure is
// retried on the next sync, as the expiry warning is.

import { and, eq, gt, gte, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import { renderDoorsCountedNotice, renderLapsedNotice } from '../../van/claim-notices.js';
import { notifyHolder } from './holder-notices.js';
import { WALK_PERCENT_WINDOW_MS } from './contact-sync.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[van]';

/** A lapse older than this is not worth telling anyone about: the turf is
 *  likely someone else's by now. Covers a sync or two that failed. */
export const LAPSE_NOTICE_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface ClaimNoticeResult {
	sent: number;
	failed: number;
}

/** Tell each holder whose claim lapsed recently, once. */
export async function notifyLapsedClaims(
	db: Db,
	options: { now: Date; appUrl: string },
): Promise<ClaimNoticeResult> {
	const since = new Date(options.now.getTime() - LAPSE_NOTICE_WINDOW_MS).toISOString();
	const rows = await db
		.select({
			id: vanTurfCheckouts.id,
			slackUserId: vanTurfCheckouts.slackUserId,
			turfName: vanTurfs.name,
			chapterId: vanTurfs.chapterId,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanTurfCheckouts.turfId))
		.where(
			and(
				eq(vanTurfCheckouts.releaseReason, 'expired'),
				isNull(vanTurfCheckouts.lapseNotifiedAt),
				gte(vanTurfCheckouts.releasedAt, since),
			),
		);
	const result = { sent: 0, failed: 0 };
	for (const row of rows) {
		const text = renderLapsedNotice({
			turfName: row.turfName,
			chapterId: row.chapterId,
			appUrl: options.appUrl,
		});
		if (!(await notifyHolder(db, row.slackUserId, 'lapsed', text, LOG, options.now))) {
			result.failed++;
			continue;
		}
		await db
			.update(vanTurfCheckouts)
			.set({ lapseNotifiedAt: options.now.toISOString() })
			.where(eq(vanTurfCheckouts.id, row.id));
		result.sent++;
	}
	return result;
}

/**
 * Tell each holder VAN has the doors from a walk they marked done, once, the
 * first time `doorsKnocked` comes to more than 0. stampDoorsKnocked keeps
 * raising that count for KNOCK_TRAIL_MS after the walk as late syncs land,
 * so the notice gives it as the count so far, not the total. A count of 0
 * is the door-delta nudge's to deal with ("unsynced"), not this.
 */
export async function notifyDoorsCounted(
	db: Db,
	options: { now: Date; appUrl: string },
): Promise<ClaimNoticeResult> {
	const since = new Date(options.now.getTime() - WALK_PERCENT_WINDOW_MS).toISOString();
	const rows = await db
		.select({
			id: vanTurfCheckouts.id,
			slackUserId: vanTurfCheckouts.slackUserId,
			doors: vanTurfCheckouts.doorsKnocked,
			turfName: vanTurfs.name,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanTurfCheckouts.turfId))
		.where(
			and(
				gte(vanTurfCheckouts.completedAt, since),
				gt(vanTurfCheckouts.doorsKnocked, 0),
				isNull(vanTurfCheckouts.doorsCountedNotifiedAt),
			),
		);
	const result = { sent: 0, failed: 0 };
	for (const row of rows) {
		const text = renderDoorsCountedNotice({
			turfName: row.turfName,
			doors: row.doors ?? 0,
			appUrl: options.appUrl,
		});
		if (!(await notifyHolder(db, row.slackUserId, 'doors-counted', text, LOG, options.now))) {
			result.failed++;
			continue;
		}
		await db
			.update(vanTurfCheckouts)
			.set({ doorsCountedNotifiedAt: options.now.toISOString() })
			.where(eq(vanTurfCheckouts.id, row.id));
		result.sent++;
	}
	return result;
}

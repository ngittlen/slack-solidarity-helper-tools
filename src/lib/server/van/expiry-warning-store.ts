// Finding the claims due an expiry warning, sending them, and remembering.
//
// The rules live in $lib/van/expiry-warning.ts and are pure; this is the part
// that touches rows and Slack. Called from /api/internal/van-sync, which
// already runs on a schedule and already holds a lock — a second cron would
// mean a second lock and a second way for two runs to double-DM the same
// volunteer.
//
// The ordering that matters: the SQL narrows to plausible candidates, and the
// pure predicate makes the actual decision. Doing it that way rather than
// expressing every condition in SQL means the rule an organizer would ask about
// ("why did Dana not get a reminder?") is answerable from a unit test rather
// than from a query plan — and the two cannot drift, because SQL here is only
// allowed to be *wider* than the predicate.

import { and, eq, isNull, lte } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import { sendDm } from '../slack-dm.js';
import { APP_URL } from '../env.js';
import {
	EXPIRY_WARNING_LEAD_HOURS,
	hoursRemaining,
	needsExpiryWarning,
	renderExpiryWarning,
	type WarnableClaim,
} from '../../van/expiry-warning.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[van]';

export interface ExpiryWarningResult {
	/** DMs that landed and were stamped. */
	sent: number;
	/** Candidates whose DM failed. Left unstamped, so the next tick retries. */
	failed: number;
}

interface CandidateRow extends WarnableClaim {
	checkoutId: number;
	turfName: string;
	regionName: string;
	doorCount: number;
	chapterId: number;
}

/**
 * Claims that might be due a warning.
 *
 * The SQL filter is deliberately looser than the real rule: unreleased,
 * uncompleted, never warned, and expiring at or before the lead horizon. It
 * does not try to express "not already lapsed" — `isActive` decides that, along
 * with the unparseable-timestamp case that a string comparison gets wrong in
 * both directions ('0000-bad' sorts below an ISO horizon and slips through;
 * 'not a date' sorts above one and is dropped). A candidate the predicate then
 * rejects costs one row read; a rule split across SQL and TypeScript that
 * disagreed would cost a volunteer their turf.
 */
async function loadCandidates(db: Db, horizon: string): Promise<CandidateRow[]> {
	const rows = await db
		.select({
			checkoutId: vanTurfCheckouts.id,
			mapRouteId: vanTurfCheckouts.mapRouteId,
			slackUserId: vanTurfCheckouts.slackUserId,
			slackUserName: vanTurfCheckouts.slackUserName,
			claimedAt: vanTurfCheckouts.claimedAt,
			expiresAt: vanTurfCheckouts.expiresAt,
			releasedAt: vanTurfCheckouts.releasedAt,
			completedAt: vanTurfCheckouts.completedAt,
			expiryWarnedAt: vanTurfCheckouts.expiryWarnedAt,
			turfName: vanTurfs.name,
			regionName: vanTurfs.regionName,
			doorCount: vanTurfs.doorCount,
			chapterId: vanTurfs.chapterId,
		})
		.from(vanTurfCheckouts)
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(
			and(
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
				isNull(vanTurfCheckouts.expiryWarnedAt),
				lte(vanTurfCheckouts.expiresAt, horizon),
			),
		);
	return rows;
}

/** Stamp a claim as warned. Only ever called after a DM actually landed. */
async function markWarned(db: Db, checkoutId: number, at: string): Promise<void> {
	await db
		.update(vanTurfCheckouts)
		.set({ expiryWarnedAt: at })
		.where(eq(vanTurfCheckouts.id, checkoutId));
}

/**
 * DM every volunteer whose turf lapses within the lead window.
 *
 * Sends are sequential rather than parallel. The volume is tiny — a handful of
 * claims per tick even on a busy weekend — and Slack's per-workspace rate limit
 * is the kind of thing that turns a helpful reminder into a burst of 429s.
 *
 * Never throws. A failure to warn must not fail the sync that already wrote its
 * rows, and an unstamped candidate is simply picked up half an hour later.
 */
export async function sendExpiryWarnings(
	db: Db,
	now: Date,
	leadHours: number = EXPIRY_WARNING_LEAD_HOURS,
): Promise<ExpiryWarningResult> {
	const horizon = new Date(now.getTime() + leadHours * 3_600_000).toISOString();

	let candidates: CandidateRow[];
	try {
		candidates = await loadCandidates(db, horizon);
	} catch (err) {
		console.error(
			`${LOG} could not read expiry-warning candidates:`,
			err instanceof Error ? err.message : err,
		);
		return { sent: 0, failed: 0 };
	}

	const due = candidates.filter((row) => needsExpiryWarning(row, now, leadHours));
	let sent = 0;
	let failed = 0;

	for (const row of due) {
		const text = renderExpiryWarning({
			turfName: row.turfName,
			regionName: row.regionName,
			doorCount: row.doorCount,
			chapterId: row.chapterId,
			expiresAt: row.expiresAt,
			hoursLeft: hoursRemaining(row, now),
			appUrl: APP_URL,
		});

		if (!(await sendDm(row.slackUserId, text, LOG))) {
			failed += 1;
			continue;
		}

		try {
			await markWarned(db, row.checkoutId, now.toISOString());
			sent += 1;
		} catch (err) {
			// The DM landed but the stamp did not, so the next tick will send a
			// duplicate. Logged loudly because a repeated reminder is the visible
			// symptom and this is its only cause.
			console.error(
				`${LOG} expiry warning sent but not stamped for checkout=${row.checkoutId}:`,
				err instanceof Error ? err.message : err,
			);
			sent += 1;
		}
	}

	if (sent > 0 || failed > 0) {
		console.log(`${LOG} expiry warnings: sent=${sent} failed=${failed}`);
	}
	return { sent, failed };
}

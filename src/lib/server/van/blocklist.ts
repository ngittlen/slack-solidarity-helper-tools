// Blocking someone from turf checkout, with the side effects that make it
// actually take hold.
//
// Writing the block row alone is not enough. Two things would otherwise leave
// a blocked person operating for hours:
//
//   1. Any turf they are holding stays held, so nobody else can claim it and
//      the ledger keeps naming them as the walker.
//   2. Their session cookie remains valid for up to the 8h sliding TTL, so
//      every page keeps loading until it lapses.
//
// Both are fixed here, in one place, so no caller can do half the job.
//
// Lives under $lib/server (unlike $lib/van/access.ts, which is pure) because
// it spans three tables and needs the db handle.

import { and, eq, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';

import { sessions, vanTurfCheckouts, vanTurfs } from '../schema.js';
import { saveVanBlockedUser, deleteVanBlockedUser, type Editor } from '../settings.js';

type Database = ReturnType<typeof drizzle>;

export interface BlockResult {
	/** Turf freed by the block, for the notice posted to Slack and the DM to
	 *  the person it was taken from. Names come from the join rather than the
	 *  caller looking them up afterwards: this function is the only thing that
	 *  knows which rows it released, and by the time it returns they are no
	 *  longer distinguishable as "the ones this block freed". */
	released: { mapRouteId: number; name: string }[];
	/** Sessions invalidated, so the block lands on their next request. */
	sessionsRevoked: number;
}

/**
 * Delete every session belonging to `slackUserId`.
 *
 * The sessions table stores its payload as opaque JSON text with no user
 * column, so this scans and parses rather than filtering in SQL. That is fine
 * at this scale — one workspace, an 8-hour TTL, so the table holds tens of
 * rows — and a `LIKE '%U123%'` over serialised JSON would be both fragile and
 * capable of matching the wrong record.
 */
async function revokeSessions(db: Database, slackUserId: string): Promise<number> {
	const rows = await db.select().from(sessions);
	const doomed: string[] = [];
	for (const row of rows) {
		try {
			const parsed = JSON.parse(row.data) as { slackUserId?: unknown };
			if (parsed?.slackUserId === slackUserId) doomed.push(row.sid);
		} catch {
			// A row we can't parse isn't this user's, and isn't ours to clean up
			// here — the session store already treats unreadable rows as absent.
			continue;
		}
	}
	for (const sid of doomed) {
		await db.delete(sessions).where(eq(sessions.sid, sid));
	}
	return doomed.length;
}

/**
 * Block `target` from turf checkout, release anything they hold, and end their
 * sessions.
 *
 * Ordering matters: the block row goes in FIRST. If the process dies midway,
 * the safe failure is "blocked but still holding turf" — an organizer can free
 * that by hand — rather than "turf freed but not blocked", which would let them
 * immediately re-claim it.
 *
 * Callers must check `canBlock` from $lib/van/access.js first; this function
 * does not re-check, because it has no view of who is an admin.
 */
export async function blockFromTurfCheckout(
	db: Database,
	target: { slackUserId: string; displayName: string; reason: string },
	editor: Editor,
): Promise<BlockResult> {
	await saveVanBlockedUser(db, target, editor);

	const releasedAt = new Date().toISOString();
	const active = await db
		.select({
			id: vanTurfCheckouts.id,
			mapRouteId: vanTurfCheckouts.mapRouteId,
			name: vanTurfs.name,
		})
		.from(vanTurfCheckouts)
		// Inner join: a checkout whose turf row has vanished cannot be named in a
		// DM, and a message listing a blank is worse than one turf fewer. It is
		// still released by the update below — the loop runs over `active`.
		.innerJoin(vanTurfs, eq(vanTurfCheckouts.mapRouteId, vanTurfs.mapRouteId))
		.where(
			and(
				eq(vanTurfCheckouts.slackUserId, target.slackUserId),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
			),
		);

	for (const row of active) {
		await db
			.update(vanTurfCheckouts)
			.set({ releasedAt, releaseReason: 'blocked' })
			.where(eq(vanTurfCheckouts.id, row.id));
	}

	const sessionsRevoked = await revokeSessions(db, target.slackUserId);

	console.log(
		`[van] blocked ${target.slackUserId}: released ${active.length} turf(s), revoked ${sessionsRevoked} session(s) by ${editor.id} (${editor.name})`,
	);

	return {
		released: active.map((r) => ({ mapRouteId: r.mapRouteId, name: r.name })),
		sessionsRevoked,
	};
}

/**
 * Unblock `slackUserId`.
 *
 * Deliberately does NOT restore released turf. Someone else may have claimed
 * it in the meantime, and silently handing it back would recreate the exact
 * double-booking the whole feature exists to prevent. They re-claim like
 * anyone else.
 */
export async function unblockFromTurfCheckout(
	db: Database,
	slackUserId: string,
	editor: Editor,
): Promise<void> {
	await deleteVanBlockedUser(db, slackUserId, editor);
}

// The stored record of everyone who has signed in with Google — see the
// `google_volunteers` table in schema.ts for what it is for and who reads it.

import { and, desc, eq, inArray, isNull, like } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { googleVolunteers, turfNotices, vanTurfCheckouts } from './schema.js';
import { GOOGLE_ID_PREFIX, isGoogleUserId } from './identity.js';
import { errMessage } from '../err-message.js';
import type { HolderAccount } from '../holder-account.js';

type Database = ReturnType<typeof drizzle>;

export interface GoogleVolunteer {
	userId: string;
	email: string;
	displayName: string;
	firstSignedInAt: string;
	lastSignedInAt: string;
}

/**
 * Record a Google sign-in: insert on the first, refresh email, name and the
 * last-seen time on every one after. The first sign-in time never moves.
 */
export async function recordGoogleSignIn(
	db: Database,
	volunteer: { userId: string; email: string; displayName: string },
	now: Date = new Date(),
): Promise<void> {
	const at = now.toISOString();
	await db
		.insert(googleVolunteers)
		.values({ ...volunteer, firstSignedInAt: at, lastSignedInAt: at })
		.onConflictDoUpdate({
			target: googleVolunteers.userId,
			set: { email: volunteer.email, displayName: volunteer.displayName, lastSignedInAt: at },
		});
}

/** Every stored Google volunteer, by name — for the block-list picker. */
export async function loadGoogleVolunteers(db: Database): Promise<GoogleVolunteer[]> {
	const rows = await db.select().from(googleVolunteers);
	return rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function loadGoogleVolunteer(
	db: Database,
	userId: string,
): Promise<GoogleVolunteer | null> {
	const rows = await db.select().from(googleVolunteers).where(eq(googleVolunteers.userId, userId));
	return rows[0] ?? null;
}

/** Someone an admin can pick to block. `email` is null for a holder with no
 *  stored record. */
export interface BlockableGoogleVolunteer {
	userId: string;
	displayName: string;
	email: string | null;
}

/**
 * Every Google volunteer an admin may need to block: everyone with a stored
 * record, plus anyone holding turf right now who has none. The second group
 * exists because a record can be missing while its owner is still signed in
 * and claiming — cleared by an admin mid-campaign, or never written because
 * the sign-in's write failed — and a block has to be possible then most of
 * all. Their name comes from their newest claim.
 */
export async function loadBlockableGoogleVolunteers(
	db: Database,
): Promise<BlockableGoogleVolunteer[]> {
	const records = await loadGoogleVolunteers(db);
	const known = new Set(records.map((r) => r.userId));
	const holders = await db
		.select({ userId: vanTurfCheckouts.slackUserId, name: vanTurfCheckouts.slackUserName })
		.from(vanTurfCheckouts)
		.where(
			and(
				like(vanTurfCheckouts.slackUserId, `${GOOGLE_ID_PREFIX}%`),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
			),
		);
	const extra = new Map<string, string>();
	for (const h of holders) if (!known.has(h.userId)) extra.set(h.userId, h.name);
	return [
		...records.map((r) => ({ userId: r.userId, displayName: r.displayName, email: r.email })),
		...[...extra].map(([userId, displayName]) => ({ userId, displayName, email: null })),
	].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * The name to block a Google volunteer under: their stored record's, or —
 * when there is none — the one on their newest claim. Null when the id has
 * neither, i.e. nobody by that id has ever signed in or held turf.
 */
export async function googleBlockTargetName(db: Database, userId: string): Promise<string | null> {
	const record = await loadGoogleVolunteer(db, userId);
	if (record) return record.displayName;
	const [latest] = await db
		.select({ name: vanTurfCheckouts.slackUserName })
		.from(vanTurfCheckouts)
		.where(eq(vanTurfCheckouts.slackUserId, userId))
		.orderBy(desc(vanTurfCheckouts.claimedAt))
		.limit(1);
	return latest?.name ?? null;
}

/**
 * Delete every stored Google volunteer (FR-020a, end of a campaign), and the
 * turf messages kept for them — the campaign is over, and some name a MiniVAN
 * list number. Blocks and past claims are left alone: they hold their own
 * display name, and a block must outlive the record or clearing would quietly
 * unblock people. Returns how many volunteer records went.
 */
export async function clearGoogleVolunteers(db: Database): Promise<number> {
	// One batch, so it is all or nothing: a failure part-way must not leave the
	// records gone while the admin is told the clear failed.
	const [gone] = await db.batch([
		db.delete(googleVolunteers).returning({ userId: googleVolunteers.userId }),
		db.delete(turfNotices).where(like(turfNotices.userId, `${GOOGLE_ID_PREFIX}%`)),
	]);
	return gone.length;
}

/**
 * The account behind each holder id, for an admin's view. Slack ids need no
 * lookup; Google ids get their email from the stored record.
 *
 * Never throws: the mark and email are a convenience on pages whose real job
 * is the turf, so a failed read shows Google holders without an email rather
 * than taking the organizer board down.
 */
export async function loadHolderAccounts(
	db: Database,
	holderIds: Iterable<string>,
): Promise<Map<string, HolderAccount>> {
	const ids = [...new Set(holderIds)];
	const googleIds = ids.filter(isGoogleUserId);

	const emails = new Map<string, string>();
	if (googleIds.length > 0) {
		try {
			const rows = await db
				.select({ userId: googleVolunteers.userId, email: googleVolunteers.email })
				.from(googleVolunteers)
				.where(inArray(googleVolunteers.userId, googleIds));
			for (const row of rows) emails.set(row.userId, row.email);
		} catch (err) {
			console.error('[google] could not read volunteer emails:', errMessage(err));
		}
	}

	return new Map(
		ids.map((id) => [
			id,
			isGoogleUserId(id)
				? { provider: 'google' as const, email: emails.get(id) ?? null }
				: { provider: 'slack' as const, email: null },
		]),
	);
}

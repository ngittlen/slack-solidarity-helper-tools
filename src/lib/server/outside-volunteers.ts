// The stored record of everyone who has signed in outside Slack, with Google or
// Apple — see the `outside_volunteers` table in schema.ts for what it is for
// and who reads it.

import { and, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { googleVolunteers, outsideVolunteers, turfNotices, vanTurfCheckouts } from './schema.js';
import {
	APPLE_ID_PREFIX,
	GOOGLE_ID_PREFIX,
	isOutsideUserId,
	providerOf,
	type OutsideProvider,
} from './identity.js';
import { errMessage } from '../err-message.js';
import type { HolderAccount } from '../holder-account.js';

type Database = ReturnType<typeof drizzle>;

export interface OutsideVolunteer {
	userId: string;
	provider: OutsideProvider;
	email: string;
	isPrivateEmail: boolean;
	/** Null until they have a usable name — see the table's comment. */
	displayName: string | null;
	firstSignedInAt: string;
	lastSignedInAt: string;
}

/** Holder ids that are not Slack's, for a LIKE over a column of them. */
function isOutsideColumn(column: typeof vanTurfCheckouts.slackUserId | typeof turfNotices.userId) {
	return or(like(column, `${GOOGLE_ID_PREFIX}%`), like(column, `${APPLE_ID_PREFIX}%`));
}

/**
 * Record a sign-in: insert on the first, refresh the email and last-seen time
 * on every one after. The first sign-in time never moves.
 *
 * The name is where the two providers differ. A Google profile name refreshes
 * the stored one whenever there is one. Apple sends a name only on the first
 * authorization, and the spec fixes it there, so a stored Apple name is kept
 * over anything sent later. Either way a null name never erases a stored one —
 * that would be a volunteer who typed their name being asked for it again.
 *
 * Returns the name now stored, which is what the session should carry.
 */
export async function recordOutsideSignIn(
	db: Database,
	volunteer: {
		userId: string;
		provider: OutsideProvider;
		email: string;
		isPrivateEmail: boolean;
		displayName: string | null;
	},
	now: Date = new Date(),
): Promise<string | null> {
	const at = now.toISOString();
	const name =
		volunteer.provider === 'google'
			? sql`coalesce(excluded.display_name, ${outsideVolunteers.displayName})`
			: sql`coalesce(${outsideVolunteers.displayName}, excluded.display_name)`;
	const [row] = await db
		.insert(outsideVolunteers)
		.values({ ...volunteer, firstSignedInAt: at, lastSignedInAt: at })
		.onConflictDoUpdate({
			target: outsideVolunteers.userId,
			set: {
				email: volunteer.email,
				isPrivateEmail: volunteer.isPrivateEmail,
				displayName: name,
				lastSignedInAt: at,
			},
		})
		.returning({ displayName: outsideVolunteers.displayName });
	return row?.displayName ?? null;
}

/**
 * Store the name a volunteer typed on /turfs — once. The write only lands on a
 * record that has no name yet, so a second tab, a replayed form or a later
 * attempt to rename cannot change it (FR-011b of specs/014-apple-sso-login).
 *
 *   saved     — this name is now theirs
 *   taken     — they already had one, returned so the session can catch up
 *   no-record — nothing to write to: the record was cleared, or the sign-in
 *               could not write it. The caller still lets them use the name
 *               for this session; they are asked again next sign-in.
 */
export async function setDisplayNameOnce(
	db: Database,
	userId: string,
	displayName: string,
): Promise<
	{ status: 'saved' } | { status: 'taken'; displayName: string } | { status: 'no-record' }
> {
	const updated = await db
		.update(outsideVolunteers)
		.set({ displayName })
		.where(and(eq(outsideVolunteers.userId, userId), isNull(outsideVolunteers.displayName)))
		.returning({ userId: outsideVolunteers.userId });
	if (updated.length > 0) return { status: 'saved' };

	const record = await loadOutsideVolunteer(db, userId);
	if (record?.displayName) return { status: 'taken', displayName: record.displayName };
	return { status: 'no-record' };
}

export async function loadOutsideVolunteer(
	db: Database,
	userId: string,
): Promise<OutsideVolunteer | null> {
	const rows = await db
		.select()
		.from(outsideVolunteers)
		.where(eq(outsideVolunteers.userId, userId));
	const row = rows[0];
	return row ? { ...row, provider: row.provider as OutsideProvider } : null;
}

/** How many stored records each provider has, for the settings count. */
export async function countOutsideVolunteers(
	db: Database,
): Promise<Record<OutsideProvider, number>> {
	const rows = await db
		.select({ provider: outsideVolunteers.provider, n: sql<number>`count(*)` })
		.from(outsideVolunteers)
		.groupBy(outsideVolunteers.provider);
	const counts: Record<OutsideProvider, number> = { google: 0, apple: 0 };
	for (const row of rows) {
		if (row.provider === 'google' || row.provider === 'apple') counts[row.provider] = Number(row.n);
	}
	return counts;
}

/** Someone an admin can pick to block. `email` is null for a holder with no
 *  stored record. */
export interface BlockableOutsideVolunteer {
	userId: string;
	provider: OutsideProvider;
	displayName: string;
	email: string | null;
	/** An Apple Hide My Email relay address. False with no stored record. */
	isPrivateEmail: boolean;
}

/** What to call a volunteer who has no name anywhere — signed in, never named
 *  themselves, and so never claimed. Only an admin ever sees it. */
function unnamed(provider: OutsideProvider): string {
	return provider === 'apple' ? 'Unnamed Apple volunteer' : 'Unnamed Google volunteer';
}

/**
 * Every outside volunteer an admin may need to block: everyone with a stored
 * record, plus anyone holding turf right now who has none. The second group
 * exists because a record can be missing while its owner is still signed in
 * and claiming — cleared by an admin mid-campaign, or never written because
 * the sign-in's write failed — and a block has to be possible then most of
 * all. Their name comes from their newest claim.
 */
export async function loadBlockableOutsideVolunteers(
	db: Database,
): Promise<BlockableOutsideVolunteer[]> {
	const records = await db.select().from(outsideVolunteers);
	const known = new Set(records.map((r) => r.userId));
	const holders = await db
		.select({ userId: vanTurfCheckouts.slackUserId, name: vanTurfCheckouts.slackUserName })
		.from(vanTurfCheckouts)
		.where(
			and(
				isOutsideColumn(vanTurfCheckouts.slackUserId),
				isNull(vanTurfCheckouts.releasedAt),
				isNull(vanTurfCheckouts.completedAt),
			),
		);
	const extra = new Map<string, string>();
	for (const h of holders) if (!known.has(h.userId)) extra.set(h.userId, h.name);
	return [
		...records.map((r) => {
			const provider = r.provider as OutsideProvider;
			return {
				userId: r.userId,
				provider,
				displayName: r.displayName ?? unnamed(provider),
				email: r.email,
				isPrivateEmail: r.isPrivateEmail,
			};
		}),
		...[...extra].map(([userId, displayName]) => ({
			userId,
			provider: providerOf(userId) as OutsideProvider,
			displayName,
			email: null,
			isPrivateEmail: false,
		})),
	].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * The name to block an outside volunteer under: their stored record's, or —
 * when there is none — the one on their newest claim. Null when the id has
 * neither, i.e. nobody by that id has ever signed in or held turf.
 */
export async function outsideBlockTargetName(db: Database, userId: string): Promise<string | null> {
	const record = await loadOutsideVolunteer(db, userId);
	if (record) return record.displayName ?? unnamed(record.provider);
	const [latest] = await db
		.select({ name: vanTurfCheckouts.slackUserName })
		.from(vanTurfCheckouts)
		.where(eq(vanTurfCheckouts.slackUserId, userId))
		.orderBy(desc(vanTurfCheckouts.claimedAt))
		.limit(1);
	return latest?.name ?? null;
}

/**
 * Delete every stored outside volunteer, Google and Apple alike (end of a
 * campaign), and the turf messages kept for them — the campaign is over, and
 * some name a MiniVAN list number. Blocks and past claims are left alone: they
 * hold their own display name, and a block must outlive the record or clearing
 * would quietly unblock people. Returns how many volunteer records went.
 */
export async function clearOutsideVolunteers(db: Database): Promise<number> {
	// One batch, so it is all or nothing: a failure part-way must not leave the
	// records gone while the admin is told the clear failed.
	const [gone] = await db.batch([
		db.delete(outsideVolunteers).returning({ userId: outsideVolunteers.userId }),
		db.delete(turfNotices).where(isOutsideColumn(turfNotices.userId)),
		// The retired table still holds the copies 0063 took its rows from,
		// emails included, until a later release drops it (see schema.ts). A
		// clear that left them would not be a clear.
		db.delete(googleVolunteers),
	]);
	return gone.length;
}

/**
 * The account behind each holder id, for an admin's view. Slack ids need no
 * lookup; outside ids get their email from the stored record.
 *
 * Never throws: the mark and email are a convenience on pages whose real job
 * is the turf, so a failed read shows outside holders without an email rather
 * than taking the organizer board down.
 */
export async function loadHolderAccounts(
	db: Database,
	holderIds: Iterable<string>,
): Promise<Map<string, HolderAccount>> {
	const ids = [...new Set(holderIds)];
	const outsideIds = ids.filter(isOutsideUserId);

	const emails = new Map<string, { email: string; isPrivateEmail: boolean }>();
	if (outsideIds.length > 0) {
		try {
			const rows = await db
				.select({
					userId: outsideVolunteers.userId,
					email: outsideVolunteers.email,
					isPrivateEmail: outsideVolunteers.isPrivateEmail,
				})
				.from(outsideVolunteers)
				.where(inArray(outsideVolunteers.userId, outsideIds));
			for (const row of rows) emails.set(row.userId, row);
		} catch (err) {
			console.error('[outside] could not read volunteer emails:', errMessage(err));
		}
	}

	return new Map(
		ids.map((id) => {
			const provider = providerOf(id);
			const record = provider === 'slack' ? undefined : emails.get(id);
			return [
				id,
				{
					provider,
					email: record?.email ?? null,
					isPrivateEmail: record?.isPrivateEmail ?? false,
				},
			];
		}),
	);
}

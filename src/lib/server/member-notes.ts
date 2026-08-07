// Reads and writes for the member moderation log.

import { and, desc, eq, lte, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { memberNotes, type MemberNoteRow } from './schema.js';

// Same alias the settings layer uses, so callers can pass the shared `db`.
type Database = ReturnType<typeof drizzle>;

export type NoteKind = 'note' | 'warning';

export interface NewNoteInput {
	slackUserId: string;
	kind: NoteKind;
	body: string;
	messageLink: string | null;
	messageChannelId: string | null;
	messageTs: string | null;
	dmRequested: boolean;
	authorSlackUserId: string;
	authorSlackUserName: string;
	source: 'slash' | 'shortcut';
}

export interface InsertedNote {
	id: number;
	/** All-time warning rank, or null for a plain note. */
	warningNumber: number | null;
}

/**
 * Insert a note and, for warnings, compute and persist its all-time rank.
 *
 * The ordering here is deliberate. Counting existing warnings *before*
 * inserting would let two admins warning the same member at the same moment
 * both read N and both be told they're the (N+1)th — two DMs claiming to be
 * "your second warning". Inserting first makes the autoincrement id a total
 * order, so counting rows with `id <= mine` gives every concurrent writer a
 * distinct, gap-free rank without a transaction or a lock (which matters over
 * libSQL-on-HTTP, where interactive transactions are expensive).
 *
 * The rank is then stored rather than derived on read, so the number in the
 * member's DM and the number on the page can never drift apart — including
 * after a row is deleted years later.
 */
export async function insertNote(db: Database, input: NewNoteInput): Promise<InsertedNote> {
	const [inserted] = await db
		.insert(memberNotes)
		.values({
			slackUserId: input.slackUserId,
			kind: input.kind,
			body: input.body,
			messageLink: input.messageLink,
			messageChannelId: input.messageChannelId,
			messageTs: input.messageTs,
			dmRequested: input.dmRequested,
			authorSlackUserId: input.authorSlackUserId,
			authorSlackUserName: input.authorSlackUserName,
			createdAt: new Date().toISOString(),
			source: input.source,
		})
		.returning({ id: memberNotes.id });

	const id = inserted!.id;
	if (input.kind !== 'warning') return { id, warningNumber: null };

	const [ranked] = await db
		.select({ rank: sql<number>`count(*)` })
		.from(memberNotes)
		.where(
			and(
				eq(memberNotes.slackUserId, input.slackUserId),
				eq(memberNotes.kind, 'warning'),
				lte(memberNotes.id, id),
			),
		);

	const warningNumber = Number(ranked?.rank ?? 1) || 1;
	await db.update(memberNotes).set({ warningNumber }).where(eq(memberNotes.id, id));

	return { id, warningNumber };
}

/** Record how the warning DM went. Called after the HTTP response, so its
 *  failure can never cost us the note itself. */
export async function recordDmOutcome(
	db: Database,
	noteId: number,
	outcome: { sentAt?: string; status?: string; body?: string },
): Promise<void> {
	await db
		.update(memberNotes)
		.set({
			dmSentAt: outcome.sentAt ?? null,
			dmStatus: outcome.status ?? null,
			dmBody: outcome.body ?? null,
		})
		.where(eq(memberNotes.id, noteId));
}

/** Every note for one member, newest first. */
export function listNotes(db: Database, slackUserId: string): Promise<MemberNoteRow[]> {
	return db
		.select()
		.from(memberNotes)
		.where(eq(memberNotes.slackUserId, slackUserId))
		.orderBy(desc(memberNotes.id));
}

// Sending mentor-walk messages (specs/015-mentor-walks, User Story 5, FR-022
// to FR-026).
//
// Everything goes through the `mentor_walk_messages` outbox. A message is
// queued under a key naming its event — `off:12`, `join:40:<joinedAt>` — and
// the key is unique per person, so however often an event is processed, it
// is queued once and sent once (FR-026). Sending is separate: an action
// dispatches straight after queueing, so messages go at once, and the sweep
// retries whatever didn't go.
//
// Whether someone may hear about mentor walks is checked when the message is
// sent, not when it is queued: the setting, their role and the block list can
// all change in between (FR-040, SC-007).

import { and, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { mentorWalkMessages, mentorWalks } from '../schema.js';
import { loadSettings, loadVanBlockedIds, type Settings } from '../settings.js';
import { featureVisible } from '../../mentor-walks/rules.js';
import type { WalkMessageKind } from '../../mentor-walks/messages.js';
import { errMessage } from '../../err-message.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[mentor-walks]';
/** Tries before a message is given up on. */
export const MAX_SEND_ATTEMPTS = 5;
/** A claim this old was abandoned mid-send, and is tried again. */
const CLAIM_TIMEOUT_MS = 10 * 60_000;
/** Per run, so one sweep stays short. */
const BATCH = 100;

export interface OutgoingMessage {
	holderId: string;
	walkId: number | null;
	eventKey: string;
	kind: WalkMessageKind;
	text: string;
	/** `held` queues an alert over the daily limit without sending it. */
	status?: 'pending' | 'held';
}

/** Queue messages; any already queued under the same key are left alone.
 *  The ones newly queued. */
export async function enqueue(db: Db, rows: OutgoingMessage[], now: Date): Promise<number> {
	if (rows.length === 0) return 0;
	const at = now.toISOString();
	const inserted = await db
		.insert(mentorWalkMessages)
		.values(
			rows.map((r) => ({
				holderId: r.holderId,
				walkId: r.walkId,
				eventKey: r.eventKey,
				kind: r.kind,
				text: r.text,
				status: r.status ?? 'pending',
				createdAt: at,
			})),
		)
		.onConflictDoNothing()
		.returning({ id: mentorWalkMessages.id });
	return inserted.length;
}

/** Who may hear about mentor walks right now: the same rule as who sees them. */
export function canHear(
	holderId: string,
	settings: Pick<
		Settings,
		'mentorWalksVisibility' | 'allowedSlackUserIds' | 'moderatorSlackUserIds'
	>,
	blockedIds: ReadonlySet<string>,
	superuserId: string,
): boolean {
	const isAdmin =
		(superuserId !== '' && holderId === superuserId) || settings.allowedSlackUserIds.has(holderId);
	const isModerator = !isAdmin && settings.moderatorSlackUserIds.has(holderId);
	return featureVisible(
		settings.mentorWalksVisibility,
		{ isAdmin, isModerator },
		blockedIds.has(holderId),
	);
}

export type SendFn = (
	db: Db,
	holderId: string,
	kind: WalkMessageKind,
	text: string,
	logTag: string,
	now: Date,
) => Promise<boolean>;

export interface DispatchDeps {
	send: SendFn;
	superuserId: string;
}

/**
 * Send what's queued. Each message is claimed before it's sent, so the sweep
 * and an action dispatching at the same moment never both send it. Never
 * throws.
 */
export async function dispatchPending(
	db: Db,
	now: Date,
	deps: DispatchDeps,
): Promise<{ sent: number; skipped: number; failed: number }> {
	const tally = { sent: 0, skipped: 0, failed: 0 };
	try {
		const at = now.toISOString();
		const staleClaim = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString();
		const due = await db
			.select({ id: mentorWalkMessages.id })
			.from(mentorWalkMessages)
			.where(
				or(
					eq(mentorWalkMessages.status, 'pending'),
					and(
						eq(mentorWalkMessages.status, 'sending'),
						lt(mentorWalkMessages.claimedAt, staleClaim),
					),
				),
			)
			.orderBy(mentorWalkMessages.id)
			.limit(BATCH);
		if (due.length === 0) return tally;

		const claimed = await db
			.update(mentorWalkMessages)
			.set({ status: 'sending', claimedAt: at, attempts: sql`${mentorWalkMessages.attempts} + 1` })
			.where(
				and(
					inArray(
						mentorWalkMessages.id,
						due.map((d) => d.id),
					),
					or(
						eq(mentorWalkMessages.status, 'pending'),
						and(
							eq(mentorWalkMessages.status, 'sending'),
							lt(mentorWalkMessages.claimedAt, staleClaim),
						),
					),
				),
			)
			.returning();
		if (claimed.length === 0) return tally;

		const [settings, blockedIds] = await Promise.all([loadSettings(db), loadVanBlockedIds(db)]);
		// A reminder is only worth sending before its walk, and only while it's
		// on. That also keeps the number it carries out of anything stored
		// after the start, which purgeExpiredPhones relies on.
		const reminderWalkIds = [
			...new Set(
				claimed.flatMap((m) => (m.kind === 'walk-reminder' && m.walkId !== null ? [m.walkId] : [])),
			),
		];
		const upcoming = new Set(
			reminderWalkIds.length === 0
				? []
				: (
						await db
							.select({ id: mentorWalks.id })
							.from(mentorWalks)
							.where(
								and(
									inArray(mentorWalks.id, reminderWalkIds),
									eq(mentorWalks.status, 'scheduled'),
									gt(mentorWalks.startsAt, at),
								),
							)
					).map((w) => w.id),
		);
		for (const message of claimed) {
			let status: 'sent' | 'skipped' | 'pending' | 'failed';
			const lateReminder =
				message.kind === 'walk-reminder' &&
				(message.walkId === null || !upcoming.has(message.walkId));
			if (lateReminder || !canHear(message.holderId, settings, blockedIds, deps.superuserId)) {
				status = 'skipped';
			} else {
				let delivered = false;
				try {
					delivered = await deps.send(
						db,
						message.holderId,
						message.kind as WalkMessageKind,
						message.text,
						LOG,
						now,
					);
				} catch (err) {
					console.error(`${LOG} sending ${message.eventKey} failed:`, errMessage(err));
				}
				if (delivered) status = 'sent';
				else if (message.attempts >= MAX_SEND_ATTEMPTS) {
					status = 'failed';
					console.error(
						`${LOG} gave up on ${message.kind} (${message.eventKey}) for ${message.holderId} after ${message.attempts} tries`,
					);
				} else status = 'pending';
			}
			if (status !== 'pending') tally[status] += 1;
			await db
				.update(mentorWalkMessages)
				.set({ status, sentAt: status === 'sent' ? at : null })
				.where(eq(mentorWalkMessages.id, message.id));
		}
		if (tally.sent + tally.skipped + tally.failed > 0) {
			console.log(
				`${LOG} messages: ${tally.sent} sent, ${tally.skipped} skipped, ${tally.failed} given up`,
			);
		}
	} catch (err) {
		console.error(`${LOG} dispatching messages failed:`, errMessage(err));
	}
	return tally;
}

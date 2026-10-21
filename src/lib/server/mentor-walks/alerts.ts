// Nearby-walk alerts (specs/015-mentor-walks, User Story 7, FR-027–FR-029).
//
// Someone gives a ZIP and a radius; from then on, each walk with open seats
// that meets within that radius gets them one alert, when it first comes
// within CARD_WINDOW_DAYS of starting. The alert's key is the walk, so editing
// a walk never alerts anyone twice, and a walk moved into someone's range
// alerts them for the first time (US7, scenario 3). At most ALERTS_PER_DAY go
// to a person in a campaign day; the rest wait, and the next alert says how
// many more there are.

import { and, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import {
	mentors,
	mentorWalkAlerts,
	mentorWalkMessages,
	mentorWalks,
	mentorWalkSeats,
	type MentorWalkAlertRow,
} from '../schema.js';
import { lookupZipCentroid, normalizeZip } from '../van/zip-centroid.js';
import {
	ALERTS_PER_DAY,
	CARD_WINDOW_DAYS,
	distanceLabel,
	isAlertRadius,
	milesBetween,
} from '../../mentor-walks/rules.js';
import { alertMessage } from '../../mentor-walks/messages.js';
import { campaignDayKey } from '../../campaign-time.js';
import { enqueue, type OutgoingMessage } from './notify.js';
import { factsOf } from './walk-events.js';
import type { Person } from './store.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[mentor-walks]';
const DAY_MS = 86_400_000;

export const ZIP_NOT_FOUND = "We couldn't find that ZIP code. Check it and try again.";

export async function loadAlerts(db: Db, holderId: string): Promise<MentorWalkAlertRow | null> {
	const [row] = await db
		.select()
		.from(mentorWalkAlerts)
		.where(eq(mentorWalkAlerts.holderId, holderId));
	return row ?? null;
}

/** Turn alerts on, or change them. The ZIP must be found on the map first;
 *  until it is, alerts stay as they were. */
export async function saveAlerts(
	db: Db,
	holder: Person,
	rawZip: string,
	radius: number,
	now: Date,
	lookup: typeof lookupZipCentroid = lookupZipCentroid,
): Promise<{ ok: true } | { ok: false; message: string }> {
	const zip = normalizeZip(rawZip);
	if (!zip) return { ok: false, message: 'Enter a 5-digit ZIP code.' };
	if (!isAlertRadius(radius)) return { ok: false, message: 'Pick 5, 10 or 25 miles.' };
	const point = await lookup(db, zip);
	if (!point) return { ok: false, message: ZIP_NOT_FOUND };
	const at = now.toISOString();
	const values = {
		holderName: holder.name,
		zip,
		lat: point.lat,
		lng: point.lng,
		radiusMiles: radius,
		updatedAt: at,
	};
	await db
		.insert(mentorWalkAlerts)
		.values({ holderId: holder.id, createdAt: at, ...values })
		.onConflictDoUpdate({ target: mentorWalkAlerts.holderId, set: values });
	console.log(`${LOG} ${holder.name} (${holder.id}) turned on walk alerts, ${radius} mi`);
	return { ok: true };
}

export async function stopAlerts(db: Db, holderId: string): Promise<boolean> {
	const gone = await db
		.delete(mentorWalkAlerts)
		.where(eq(mentorWalkAlerts.holderId, holderId))
		.returning({ id: mentorWalkAlerts.holderId });
	if (gone.length > 0) console.log(`${LOG} ${holderId} turned off walk alerts`);
	return gone.length > 0;
}

/** For the sweep: queue an alert to everyone near a walk that has come into
 *  the window with seats open (FR-028). */
export async function queueAlerts(db: Db, now: Date, appUrl: string): Promise<number> {
	const at = now.toISOString();
	const until = new Date(now.getTime() + CARD_WINDOW_DAYS * DAY_MS).toISOString();
	const subscribers = await db.select().from(mentorWalkAlerts);
	if (subscribers.length === 0) return 0;

	const walks = await db
		.select({
			walk: mentorWalks,
			taken: sql<number>`(SELECT count(*) FROM ${mentorWalkSeats} s
				WHERE s.walk_id = ${mentorWalks.id} AND s.left_at IS NULL)`,
		})
		.from(mentorWalks)
		.innerJoin(mentors, eq(mentors.holderId, mentorWalks.mentorId))
		.where(
			and(
				eq(mentorWalks.status, 'scheduled'),
				eq(mentors.status, 'active'),
				gt(mentorWalks.startsAt, at),
				lte(mentorWalks.startsAt, until),
			),
		)
		.orderBy(mentorWalks.startsAt);
	const open = walks.filter((w) => Number(w.taken) < w.walk.seats);
	if (open.length === 0) return 0;

	// What each subscriber has already been alerted about or has taken a
	// seat on, even one since given up, and how many alerts have gone to
	// them today.
	const ids = subscribers.map((s) => s.holderId);
	const since = new Date(now.getTime() - 2 * DAY_MS).toISOString();
	const [alerted, seats, recent] = await Promise.all([
		db
			.select({ holderId: mentorWalkMessages.holderId, walkId: mentorWalkMessages.walkId })
			.from(mentorWalkMessages)
			.where(
				and(eq(mentorWalkMessages.kind, 'walk-alert'), inArray(mentorWalkMessages.holderId, ids)),
			),
		db
			.select({ holderId: mentorWalkSeats.holderId, walkId: mentorWalkSeats.walkId })
			.from(mentorWalkSeats)
			.where(inArray(mentorWalkSeats.holderId, ids)),
		db
			.select({
				holderId: mentorWalkMessages.holderId,
				status: mentorWalkMessages.status,
				createdAt: mentorWalkMessages.createdAt,
			})
			.from(mentorWalkMessages)
			.where(
				and(
					eq(mentorWalkMessages.kind, 'walk-alert'),
					inArray(mentorWalkMessages.holderId, ids),
					gte(mentorWalkMessages.createdAt, since),
				),
			),
	]);
	const known = new Set([...alerted, ...seats].map((r) => `${r.holderId}:${r.walkId}`));
	const today = campaignDayKey(at);

	let queued = 0;
	for (const sub of subscribers) {
		const near = open.filter(
			({ walk }) =>
				walk.mentorId !== sub.holderId &&
				!known.has(`${sub.holderId}:${walk.id}`) &&
				milesBetween(sub, walk) <= sub.radiusMiles,
		);
		if (near.length === 0) continue;
		let sentToday = recent.filter(
			(m) =>
				m.holderId === sub.holderId &&
				m.status !== 'held' &&
				m.status !== 'summarized' &&
				campaignDayKey(m.createdAt) === today,
		).length;
		const rows: OutgoingMessage[] = [];
		for (const { walk, taken } of near) {
			const facts = factsOf(walk);
			const miles = distanceLabel(milesBetween(sub, walk));
			if (sentToday >= ALERTS_PER_DAY) {
				rows.push({
					holderId: sub.holderId,
					walkId: walk.id,
					eventKey: `alert:${walk.id}`,
					kind: 'walk-alert',
					text: alertMessage(facts, walk.seats - Number(taken), miles, 0, appUrl, now),
					status: 'held',
				});
				continue;
			}
			const more = await takeHeld(db, sub.holderId, now);
			rows.push({
				holderId: sub.holderId,
				walkId: walk.id,
				eventKey: `alert:${walk.id}`,
				kind: 'walk-alert',
				text: alertMessage(facts, walk.seats - Number(taken), miles, more, appUrl, now),
			});
			sentToday += 1;
		}
		queued += await enqueue(db, rows, now);
	}
	return queued;
}

/** Mark someone's held alerts as summarized in the one about to go, and say
 *  how many there were. Only walks that haven't started still count. */
async function takeHeld(db: Db, holderId: string, now: Date): Promise<number> {
	const held = await db
		.update(mentorWalkMessages)
		.set({ status: 'summarized' })
		.where(
			and(
				eq(mentorWalkMessages.holderId, holderId),
				eq(mentorWalkMessages.kind, 'walk-alert'),
				eq(mentorWalkMessages.status, 'held'),
				sql`${mentorWalkMessages.walkId} IN (SELECT id FROM ${mentorWalks}
					WHERE status = 'scheduled' AND starts_at > ${now.toISOString()})`,
			),
		)
		.returning({ id: mentorWalkMessages.id });
	return held.length;
}

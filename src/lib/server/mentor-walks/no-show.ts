// "Mentor didn't show" reports in the Turf sync channel (specs/015-mentor-
// walks, User Story 6, FR-032).
//
// The report itself is the seat's answer, recorded whatever happens here, so
// it reaches the organizer view even with no channel set. This only posts:
// the first report on a walk as a channel message, later ones as replies in
// its thread. A seat's report is marked once posted, and anything not yet
// posted is tried again by the next sweep.

import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { mentorWalks, mentorWalkSeats } from '../schema.js';
import { noShowPost, noShowReply } from '../../mentor-walks/messages.js';
import { CHECKIN_DAYS } from '../../mentor-walks/rules.js';
import { factsOf } from './walk-events.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[mentor-walks]';
/** A first-post claim this old was abandoned, and is taken over. */
const CLAIM_TIMEOUT_MS = 10 * 60_000;

export type PostFn = (
	channelId: string,
	text: string,
	logTag: string,
	threadTs?: string,
) => Promise<string | null>;

export interface NoShowDeps {
	post: PostFn;
	/** The Turf sync channel; '' when none is set. */
	channelId: string;
	chapterName: (chapterId: number) => string;
	appUrl: string;
}

/** Post one walk's reports that haven't been posted yet. Never throws. */
export async function postNoShows(db: Db, walkId: number, deps: NoShowDeps): Promise<void> {
	if (!deps.channelId) return;
	try {
		const reports = await db
			.select()
			.from(mentorWalkSeats)
			.where(
				and(
					eq(mentorWalkSeats.walkId, walkId),
					isNull(mentorWalkSeats.leftAt),
					eq(mentorWalkSeats.answer, 'no-show'),
					isNull(mentorWalkSeats.reportPostedAt),
				),
			)
			.orderBy(mentorWalkSeats.answeredAt);
		if (reports.length === 0) return;
		let [walk] = await db.select().from(mentorWalks).where(eq(mentorWalks.id, walkId));
		if (!walk) return;

		for (const report of reports) {
			let posted: string | null;
			if (walk.noShowTs === null) {
				// Claim the walk's first post, so two reports landing together
				// don't both start a thread. A claim whose post fails is let go,
				// and one left by a server that stopped mid-post goes stale.
				const now = new Date();
				const stale = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString();
				const [claimed] = await db
					.update(mentorWalks)
					.set({ noShowChannel: deps.channelId, noShowClaimedAt: now.toISOString() })
					.where(
						and(
							eq(mentorWalks.id, walkId),
							isNull(mentorWalks.noShowTs),
							or(isNull(mentorWalks.noShowClaimedAt), lt(mentorWalks.noShowClaimedAt, stale)),
						),
					)
					.returning();
				if (!claimed) return; // Another request is posting it; the sweep follows up.
				posted = await deps.post(
					deps.channelId,
					noShowPost(
						factsOf(walk),
						deps.chapterName(walk.chapterId),
						report.holderName,
						deps.appUrl,
					),
					LOG,
				);
				if (posted === null) {
					await db
						.update(mentorWalks)
						.set({ noShowChannel: null, noShowClaimedAt: null })
						.where(eq(mentorWalks.id, walkId));
					return;
				}
				[walk] = await db
					.update(mentorWalks)
					.set({ noShowTs: posted })
					.where(eq(mentorWalks.id, walkId))
					.returning();
			} else {
				posted = await deps.post(
					walk.noShowChannel ?? deps.channelId,
					noShowReply(report.holderName),
					LOG,
					walk.noShowTs,
				);
				if (posted === null) return;
			}
			await db
				.update(mentorWalkSeats)
				.set({ reportPostedAt: new Date().toISOString() })
				.where(eq(mentorWalkSeats.id, report.id));
		}
	} catch (err) {
		console.error(`${LOG} posting no-show reports for walk ${walkId} failed:`, err);
	}
}

/** For the sweep: every recent walk with a report not yet posted. */
export async function postPendingNoShows(db: Db, now: Date, deps: NoShowDeps): Promise<void> {
	if (!deps.channelId) return;
	const since = new Date(now.getTime() - CHECKIN_DAYS * 86_400_000).toISOString();
	const walks = await db
		.selectDistinct({ walkId: mentorWalkSeats.walkId })
		.from(mentorWalkSeats)
		.innerJoin(mentorWalks, eq(mentorWalks.id, mentorWalkSeats.walkId))
		.where(
			and(
				eq(mentorWalkSeats.answer, 'no-show'),
				isNull(mentorWalkSeats.leftAt),
				isNull(mentorWalkSeats.reportPostedAt),
				gt(mentorWalks.startsAt, since),
			),
		);
	for (const { walkId } of walks) await postNoShows(db, walkId, deps);
}

// The live wiring for sending mentor-walk messages: notifyHolder (push, then a
// Slack DM or a /turfs notice) and the superuser id. Kept apart from
// notify.ts so that can be tested with a fake sender.

import type { drizzle } from 'drizzle-orm/libsql';
import { APP_URL, SLACK_SUPERUSER_ID } from '../env.js';
import { postToChannel } from '../slack.js';
import { notifyHolder } from '../van/holder-notices.js';
import { dispatchPending, type DispatchDeps } from './notify.js';
import type { NoShowDeps } from './no-show.js';
import { STOP_ALERTS_BLOCKS } from '../../mentor-walks/messages.js';

type Db = ReturnType<typeof drizzle>;

export const LIVE_DISPATCH: DispatchDeps = {
	send: (db, holderId, kind, text, logTag, now) =>
		notifyHolder(
			db,
			holderId,
			kind,
			text,
			logTag,
			now,
			kind === 'walk-alert' ? STOP_ALERTS_BLOCKS : [],
		),
	superuserId: SLACK_SUPERUSER_ID,
};

/** Send what's queued, without holding up the request that queued it. The
 *  sweep picks up anything this misses. */
export function dispatchSoon(db: Db): void {
	void dispatchPending(db, new Date(), LIVE_DISPATCH);
}

/** No-show posts go to the Turf sync channel (FR-032). */
export function liveNoShowDeps(
	channelId: string,
	chapterNames: ReadonlyMap<number, string>,
): NoShowDeps {
	return {
		post: postToChannel,
		channelId,
		chapterName: (id) => chapterNames.get(id) ?? `Chapter ${id}`,
		appUrl: APP_URL,
	};
}

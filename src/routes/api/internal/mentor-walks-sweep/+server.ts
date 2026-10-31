import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { INTERNAL_CRON_SECRET } from '$lib/server/env.js';
import { secretMatches } from '$lib/server/secret-compare.js';
import { APP_URL } from '$lib/server/env.js';
import { loadSettings } from '$lib/server/settings.js';
import { chaptersFromChannelMap } from '$lib/chapter-list.js';
import { purgeExpiredPhones } from '$lib/server/mentor-walks/store.js';
import { queueCheckins, queueReminders } from '$lib/server/mentor-walks/walk-events.js';
import { queueAlerts } from '$lib/server/mentor-walks/alerts.js';
import { postPendingNoShows } from '$lib/server/mentor-walks/no-show.js';
import { dispatchPending } from '$lib/server/mentor-walks/notify.js';
import { LIVE_DISPATCH, liveNoShowDeps } from '$lib/server/mentor-walks/dispatch.js';

// Mentor walk housekeeping, called every 15 minutes by the in-process
// scheduler (specs/015-mentor-walks):
// - deletes each walk's phone number a day after its start (FR-011);
// - queues reminders (FR-025), post-walk questions (FR-030) and nearby-walk
//   alerts (FR-028), then sends whatever is queued (FR-022);
// - posts no-show reports that didn't reach the Turf sync channel (FR-032).
// Auth via ?key=<INTERNAL_CRON_SECRET>. Every step is keyed so running it
// twice queues and sends nothing twice, so it needs no lock.
export const POST: RequestHandler = async ({ url }) => {
	if (!INTERNAL_CRON_SECRET) {
		console.error('[mentor-walks] INTERNAL_CRON_SECRET is not set');
		return json({ error: 'Server misconfigured' }, { status: 500 });
	}
	if (!secretMatches(url.searchParams.get('key'), INTERNAL_CRON_SECRET)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const now = new Date();
	// Each step on its own: one that fails is logged and the rest still run,
	// above all the sending, so a bad row in one doesn't hold up every message.
	const failed: string[] = [];
	async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
		try {
			return await run();
		} catch (err) {
			console.error(`[mentor-walks] sweep step ${name} failed:`, err);
			failed.push(name);
			return null;
		}
	}

	const phonesDeleted = await step('phones', () => purgeExpiredPhones(db, now));
	const settings = await step('settings', () => loadSettings(db));
	// Off means nothing is sent (FR-040): nothing new is queued either, so
	// switching it back on doesn't release a backlog.
	let alertsQueued: number | null = 0;
	if (settings && settings.mentorWalksVisibility !== 'off') {
		await step('reminders', () => queueReminders(db, now));
		await step('checkins', () => queueCheckins(db, now));
		alertsQueued = await step('alerts', () => queueAlerts(db, now, APP_URL));
		await step('no-shows', () => {
			const chapterNames = new Map(
				chaptersFromChannelMap(settings.chapterChannelMap, settings.turfCustomChapters).map((c) => [
					c.chapterId,
					c.name,
				]),
			);
			return postPendingNoShows(db, now, liveNoShowDeps(settings.slackTurfChannelId, chapterNames));
		});
	}
	// Never throws; it checks the setting itself.
	const messages = await dispatchPending(db, now, LIVE_DISPATCH);
	return json(
		{ ok: failed.length === 0, failedSteps: failed, phonesDeleted, alertsQueued, ...messages },
		{ status: failed.length === 0 ? 200 : 500 },
	);
};

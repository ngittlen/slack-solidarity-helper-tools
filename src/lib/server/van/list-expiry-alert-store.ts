// Warning the turf channel before MiniVAN list numbers expire.
//
// The rules live in $lib/van/list-expiry.ts and are pure; this is the part that
// touches rows and Slack. Called from /api/internal/van-sync after the catalog
// sync, because the catalog is what writes `printedListCreatedAt` — warning
// before it would count from the previous run's list, which is exactly the one
// an organizer may have just replaced.
//
// One message per run, and each list announced once: the stamp is the list's
// creation date, written only after Slack accepted the post, so an outage
// retries on the next run instead of losing the warning.
//
// Never throws. The sync's rows are already written by the time this runs.

import { and, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanTurfCheckouts, vanTurfs } from '../schema.js';
import { chunked } from './sql-chunk.js';
import { postAlert } from '../slack.js';
import { errMessage } from '../../err-message.js';
import { badgeShown, loadTurfCampaigns, type CampaignBadges } from './campaigns.js';
import {
	listExpiryAlerts,
	renderListExpiryAlert,
	type ListExpiryAlert,
} from '../../van/list-expiry.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[van]';

export interface ListExpiryAlertResult {
	/** Turfs named in a message Slack accepted. */
	announced: number;
	/** True when the message was composed but Slack rejected it. */
	failed: boolean;
	skipped?: 'no-channel' | 'nothing-new';
}

export async function sendListExpiryAlerts(
	db: Db,
	input: { now: Date; channelId: string; appUrl: string },
): Promise<ListExpiryAlertResult> {
	const { now, channelId, appUrl } = input;
	// Before the reads: stamping lists for a message nobody received would
	// silence them for good once a channel IS set.
	if (!channelId) return { announced: 0, failed: false, skipped: 'no-channel' };

	let alerts: ListExpiryAlert[];
	let badges: CampaignBadges;
	try {
		const [turfs, claims, campaigns] = await Promise.all([
			db
				.select({
					turfId: vanTurfs.turfId,
					campaignId: vanTurfs.campaignId,
					name: vanTurfs.name,
					regionName: vanTurfs.regionName,
					chapterName: vanTurfs.chapterName,
					printedListNumber: vanTurfs.printedListNumber,
					printedListCreatedAt: vanTurfs.printedListCreatedAt,
					listExpiryWarnedFor: vanTurfs.listExpiryWarnedFor,
					retiredAt: vanTurfs.retiredAt,
				})
				.from(vanTurfs)
				.where(and(isNull(vanTurfs.retiredAt), isNotNull(vanTurfs.printedListCreatedAt))),
			db
				.select({
					turfId: vanTurfCheckouts.turfId,
					expiresAt: vanTurfCheckouts.expiresAt,
				})
				.from(vanTurfCheckouts)
				.where(and(isNull(vanTurfCheckouts.releasedAt), isNull(vanTurfCheckouts.completedAt))),
			loadTurfCampaigns(db),
		]);
		// Open (filtered in SQL) and unexpired — the test isActive() applies,
		// without loading a full claim snapshot for it.
		const held = new Set(
			claims.filter((c) => Date.parse(c.expiresAt) > now.getTime()).map((c) => c.turfId),
		);
		// A disabled campaign's turf is no longer handed out and its VAN data is
		// frozen, so nobody should be told to reprint its lists — unless
		// someone is still out with one, whose list number may stop loading.
		const live = turfs.filter((t) => !campaigns.disabled.has(t.campaignId) || held.has(t.turfId));
		alerts = listExpiryAlerts(live, held, now);
		// Named by campaign under the same rule as the turf: an organizer
		// reprints in that campaign's VAN.
		badges = Object.fromEntries(
			Object.entries(campaigns.badges).filter(([id]) => badgeShown(campaigns, Number(id))),
		);
	} catch (err) {
		console.error(`${LOG} could not read list-expiry candidates:`, errMessage(err));
		return { announced: 0, failed: false };
	}

	const text = renderListExpiryAlert(alerts, now, appUrl, { badges });
	if (text === null) return { announced: 0, failed: false, skipped: 'nothing-new' };

	if (!(await postAlert(channelId, text, LOG))) {
		console.warn(`${LOG} list-expiry alert not posted; ${alerts.length} turf(s) will retry`);
		return { announced: 0, failed: true };
	}

	try {
		// Per creation date, since that is the value stamped; lists cut in one
		// sitting share one, so this is a handful of updates, not one per turf.
		const byCreatedAt = new Map<string, number[]>();
		for (const alert of alerts) {
			const ids = byCreatedAt.get(alert.createdAt);
			if (ids) ids.push(alert.turfId);
			else byCreatedAt.set(alert.createdAt, [alert.turfId]);
		}
		for (const [createdAt, routeIds] of byCreatedAt) {
			for (const batch of chunked(routeIds)) {
				await db
					.update(vanTurfs)
					.set({ listExpiryWarnedFor: createdAt })
					.where(inArray(vanTurfs.turfId, batch));
			}
		}
	} catch (err) {
		// Posted but not stamped, so the next run repeats the warning. Logged
		// loudly because a duplicate message is the visible symptom.
		console.error(`${LOG} list-expiry alert posted but not stamped:`, errMessage(err));
	}

	console.log(`${LOG} list-expiry alerts: announced=${alerts.length}`);
	return { announced: alerts.length, failed: false };
}

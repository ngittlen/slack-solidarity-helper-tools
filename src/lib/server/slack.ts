import { WebClient } from '@slack/web-api';
import type { drizzle } from 'drizzle-orm/libsql';

import { SLACK_BOT_TOKEN, SLACK_GROWTH_REPORT_CHANNEL_ID } from './env.js';
import { loadSettings } from './settings.js';

let _slack: WebClient | null = null;

export function getSlack(): WebClient {
	if (!_slack) {
		_slack = new WebClient(SLACK_BOT_TOKEN);
	}
	return _slack;
}

// Convenience proxy for direct use in route handlers.
export const slack = new Proxy({} as WebClient, {
	get(_target, prop) {
		return (getSlack() as unknown as Record<string | symbol, unknown>)[prop];
	},
});

/**
 * Post an operational alert to the tracking channel, never throwing.
 *
 * Used by the cron-triggered internal endpoints: a Slack outage must not turn a
 * sync that otherwise succeeded into a failed run, and the alert is the only way
 * a rejected Mobilize API key reaches a human.
 */
/**
 * An alert bound to the Mobilize-sync channel: the /settings override when one
 * is set, otherwise the growth-report channel (DB override, then env), which is
 * where these alerts went before the override existed. Reading it per request
 * means changing the channel in /settings moves these alerts too, rather than
 * leaving them pointed at a stale id.
 *
 * A settings read failure falls back rather than throwing — a DB hiccup must not
 * silence the alert that says Mobilize rejected the API key.
 */
export async function alertForMobilizeSync(
	tag: string,
	db: ReturnType<typeof drizzle>,
): Promise<(text: string) => Promise<void>> {
	let channelId = SLACK_GROWTH_REPORT_CHANNEL_ID;
	try {
		channelId = (await loadSettings(db)).slackMobilizeSyncChannelId || channelId;
	} catch (err) {
		console.error(
			`[${tag}] could not read settings for the alert channel; using env default:`,
			err instanceof Error ? err.message : err,
		);
	}
	return alertFor(tag, channelId);
}

export function alertFor(tag: string, channelId: string): (text: string) => Promise<void> {
	return async (text: string) => {
		if (!channelId) return;
		try {
			await slack.chat.postMessage({ channel: channelId, text });
		} catch (err) {
			console.error(`[${tag}] Slack alert failed:`, err instanceof Error ? err.message : err);
		}
	};
}
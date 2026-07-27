import { WebClient } from '@slack/web-api';
import { SLACK_BOT_TOKEN } from './env.js';

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
 * an expired Mobilize cookie reaches a human.
 */
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
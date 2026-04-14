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
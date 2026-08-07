// Admin check for inbound Slack requests.
//
// The web app decides `isAdmin` once at OAuth login and stores it on the
// session (see auth/slack/callback). Slack commands have no session, so they
// re-derive it from the same source of truth: the allowed_slack_users table via
// loadSettings, plus the SLACK_SUPERUSER_ID escape hatch.

import { db } from './db.js';
import { loadSettings } from './settings.js';
import { SLACK_SUPERUSER_ID } from './env.js';
import { errMessage } from '../err-message.js';

/**
 * Fails **closed**: if the settings read throws, a non-superuser is denied
 * rather than admitted. The superuser id comes from the environment and needs
 * no DB, so a database outage can't lock the workspace owner out of their own
 * moderation tooling.
 */
export async function isSlackAdmin(slackUserId: string): Promise<boolean> {
	if (SLACK_SUPERUSER_ID !== '' && slackUserId === SLACK_SUPERUSER_ID) return true;
	try {
		const { allowedSlackUserIds } = await loadSettings(db);
		return allowedSlackUserIds.has(slackUserId);
	} catch (err) {
		console.error('[member-note] admin check failed, denying:', errMessage(err));
		return false;
	}
}

export const NOT_AUTHORIZED_TEXT =
	"You're not authorized to use this — it's limited to Slack admins.";

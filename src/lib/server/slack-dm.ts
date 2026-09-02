// Sending a direct message to one Slack user.
//
// Two calls, always in the same order: `conversations.open` to get (or reuse)
// the DM channel, then `chat.postMessage` into it. Slack has no "post to a
// user" shortcut, and the open call is idempotent — it returns the existing
// channel rather than creating a second one.
//
// Extracted once a fifth caller appeared. The welcome DM, the warning DM, the
// two /settings test-send routes and the note flow each spelled this out
// inline; the turf expiry warning would have been the fifth copy of a sequence
// where the interesting part — that `channel.id` can come back missing on a
// deactivated account — is easy to drop.
//
// Returns whether it landed rather than throwing. Every caller so far treats a
// failed DM as something to log and carry on from, and the turf warning needs
// the boolean specifically: it stamps the ledger only on success, so a Slack
// outage retries on the next tick instead of silently burning the one message
// that stops a volunteer losing their turf.

import { slack } from './slack.js';
import { errMessage } from '../err-message.js';

export async function sendDm(slackUserId: string, text: string, logTag: string): Promise<boolean> {
	try {
		const dm = await slack.conversations.open({ users: slackUserId });
		const dmChannelId = (dm as { channel?: { id?: string } }).channel?.id;
		if (!dmChannelId) {
			// Happens for deactivated accounts and bots. Not an exception, just a
			// person who cannot be reached.
			console.warn(`${logTag} no DM channel for ${slackUserId}`);
			return false;
		}

		await slack.chat.postMessage({
			channel: dmChannelId,
			text,
			// Same shape as every other DM in the app: the section block renders
			// the mrkdwn, and `text` stays as the notification fallback.
			blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
		});
		return true;
	} catch (err) {
		console.error(`${logTag} DM to ${slackUserId} failed:`, errMessage(err));
		return false;
	}
}

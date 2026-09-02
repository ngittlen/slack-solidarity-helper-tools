// A Slack user's human name, for the columns that store one alongside an id.
//
// Lifted out of the interactivity route once a second caller appeared: the
// /turfs slash command fills van_turf_checkouts.slack_user_name the same way
// the note flow fills member_notes.author_slack_user_name, and two copies of a
// lookup that both fall back to the raw id would eventually fall back
// differently.
//
// Never throws. A name is decoration on a row keyed by id — losing the Slack
// call must not lose the write it was decorating, so a failure degrades to the
// id itself, which is at least resolvable by hand.

import { slack } from './slack.js';

export async function displayName(slackUserId: string): Promise<string> {
	try {
		const info = await slack.users.info({ user: slackUserId });
		const profile = (info.user as { profile?: { display_name?: string; real_name?: string } })
			?.profile;
		return profile?.display_name?.trim() || profile?.real_name?.trim() || slackUserId;
	} catch {
		return slackUserId;
	}
}

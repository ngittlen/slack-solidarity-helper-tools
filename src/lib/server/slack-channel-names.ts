// Lowercased-channel-name → id map from the cached channel list, for resolving
// the `#channel-name` tokens admins write in DM templates into real Slack
// links (<#C…>).
//
// Shared by the welcome DM (team_join) and the warning DM (member notes). A
// cache miss is deliberately non-fatal in both: names stay literal and the DM
// still goes out, because a missing channel link is a far smaller problem than
// a member never being told they were warned.

import { slack } from './slack.js';
import { getSlackChannels } from './autocomplete-sources.js';
import { errMessage } from '../err-message.js';

export async function channelNameToId(logTag: string): Promise<Map<string, string>> {
	try {
		const { items } = await getSlackChannels(slack);
		return new Map(items.map((c) => [c.name.toLowerCase(), c.id]));
	} catch (err) {
		console.error(`[${logTag}] channel list unavailable for DM link resolution:`, errMessage(err));
		return new Map();
	}
}

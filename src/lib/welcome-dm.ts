// Renders the new-member welcome DM from an admin-editable template. Two kinds
// of substitution happen at send time:
//
//   1. `{{channels}}` → the <#C…> mentions of the channels the joiner was just
//      added to (comma-joined). This is the one dynamic bit the admin can't
//      type by hand because the channel set depends on the joiner's chapters.
//   2. `#channel-name` → a real Slack channel link, via the shared tokenizer in
//      channel-tokens.ts. The template is stored raw (with `#general`, not
//      `<#C…>`) so the settings textarea stays human-editable.

import { resolveChannelLinks } from './channel-tokens.js';

// The default message, used when no template is configured. Mirrors the copy
// the bot sent before the message was made configurable.
export const DEFAULT_WELCOME_DM =
	":wave: Welcome to the volunteer slack! We've added you to {{channels}} based on your " +
	'zip code. Feel free to introduce yourself there!';

/** Render the final DM body: fall back to the default when the template is
 *  blank, substitute `{{channels}}` with the joiner's channel mentions, then
 *  resolve any `#name` links. `{{channels}}` is filled first so a channel name
 *  a joiner was added to never gets double-processed. */
export function renderWelcomeDm(
	template: string,
	channelIds: string[],
	nameToId: ReadonlyMap<string, string>,
): string {
	const body = template.trim() || DEFAULT_WELCOME_DM;
	const mentions = channelIds.map((id) => `<#${id}>`).join(', ');
	const withChannels = body.replaceAll('{{channels}}', mentions);
	return resolveChannelLinks(withChannels, nameToId);
}

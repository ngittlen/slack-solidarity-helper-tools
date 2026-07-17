// Renders the new-member welcome DM from an admin-editable template. Two kinds
// of substitution happen at send time:
//
//   1. `{{channels}}` → the <#C…> mentions of the channels the joiner was just
//      added to (comma-joined). This is the one dynamic bit the admin can't
//      type by hand because the channel set depends on the joiner's chapters.
//   2. `#channel-name` → a real Slack channel link (<#C…>) resolved against the
//      live channel list. Admins write friendly names like "#general"; Slack
//      only renders links from the <#ID> form, so we translate on the way out.
//      A name that doesn't resolve is left as literal text (the settings save
//      endpoint validates names up front, so this only bites on a rename after
//      save).
//
// The template is stored raw (with `#general`, not `<#C…>`) so the settings
// textarea stays human-editable; resolution is a pure function of the template
// plus the current channel list, kept here so the save-time validator and the
// send path share one tokenizer.

// The default message, used when no template is configured. Mirrors the copy
// the bot sent before the message was made configurable.
export const DEFAULT_WELCOME_DM =
	":wave: Welcome to the volunteer slack! We've added you to {{channels}} based on your " +
	'zip code. Feel free to introduce yourself there!';

// A `#name` token: `#` (not already part of a `<#C…>` mention) followed by a
// Slack channel name (lowercase alphanumerics plus `-`, `_`, `.`). The
// negative lookbehind keeps it from matching the `#` inside an existing
// `<#C0ABC123>` link.
const CHANNEL_TOKEN_RE = /(?<!<)#([a-z0-9][a-z0-9._-]*)/gi;

/** Lowercased channel names referenced by `#name` tokens in the template, in
 *  document order (deduped). Used by the settings save endpoint to reject a
 *  typo'd channel before it's stored. */
export function extractChannelNames(template: string): string[] {
	const seen = new Set<string>();
	for (const match of template.matchAll(CHANNEL_TOKEN_RE)) {
		seen.add(match[1]!.toLowerCase());
	}
	return [...seen];
}

/** Replace every `#name` token with `<#id>` when the name is known, leaving
 *  unknown names as-is. `nameToId` keys are lowercased channel names. */
function linkChannelNames(template: string, nameToId: ReadonlyMap<string, string>): string {
	return template.replace(CHANNEL_TOKEN_RE, (whole, name: string) => {
		const id = nameToId.get(name.toLowerCase());
		return id ? `<#${id}>` : whole;
	});
}

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
	return linkChannelNames(withChannels, nameToId);
}
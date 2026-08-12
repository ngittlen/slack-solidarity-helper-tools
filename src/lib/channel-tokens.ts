// The `#channel-name` token syntax shared by every admin-editable message this
// app sends — the welcome DM, the warning DM, and the info commands.
//
// Admins write friendly names like "#general" in the /settings textareas. Slack
// only renders a link from the `<#C…>` form, so templates are stored raw and
// translated on the way out. Keeping the tokenizer in one place is what lets the
// save-time validator and the send path agree about what counts as a channel
// reference: the validator rejects a name that doesn't exist, and the renderer
// resolves the same set of names it was checked against.
//
// Pure, and deliberately free of Slack access. Building the name→id map is the
// server's job — see src/lib/server/slack-channel-names.ts, which is the
// counterpart that feeds `nameToId` to the functions here.

// A `#name` token: `#` (not already part of a `<#C…>` mention) followed by a
// Slack channel name (lowercase alphanumerics plus `-`, `_`, `.`). The
// negative lookbehind keeps it from matching the `#` inside an existing
// `<#C0ABC123>` link.
const CHANNEL_TOKEN_RE = /(?<!<)#([a-z0-9][a-z0-9._-]*)/gi;

/** Lowercased channel names referenced by `#name` tokens in the template, in
 *  document order (deduped). Used by the settings save endpoints to reject a
 *  typo'd channel before it's stored. */
export function extractChannelNames(template: string): string[] {
	const seen = new Set<string>();
	for (const match of template.matchAll(CHANNEL_TOKEN_RE)) {
		seen.add(match[1]!.toLowerCase());
	}
	return [...seen];
}

/** Replace every `#name` token with `<#id>` when the name is known, leaving
 *  unknown names as-is. `nameToId` keys are lowercased channel names.
 *
 *  Unknown names stay literal rather than being stripped: the save endpoints
 *  validate names up front, so this only bites after a channel is renamed or
 *  archived — and a degraded message the reader can still act on beats a hole
 *  in the middle of a sentence. */
export function resolveChannelLinks(
	template: string,
	nameToId: ReadonlyMap<string, string>,
): string {
	return template.replace(CHANNEL_TOKEN_RE, (whole, name: string) => {
		const id = nameToId.get(name.toLowerCase());
		return id ? `<#${id}>` : whole;
	});
}

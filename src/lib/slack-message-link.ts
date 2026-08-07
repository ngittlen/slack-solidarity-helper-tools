// Parsing and building of Slack message permalinks, for the "link to a Slack
// message" field on a member note.
//
// Both directions are needed and both are pure:
//   - parse:  the admin pastes a permalink into the modal, and we validate it
//             and split out the channel/ts before storing.
//   - build:  the message shortcut already carries team domain + channel + ts
//             in its payload, so we can assemble the permalink locally rather
//             than spending a `chat.getPermalink` round trip in front of a
//             `trigger_id` that expires in ~3 seconds.

export interface SlackMessageRef {
	/** The permalink exactly as supplied/assembled. This is what we render. */
	url: string;
	channelId: string;
	/** Message timestamp in Slack's `1712345678.123456` form. */
	ts: string;
	/** Parent timestamp when the link points at a threaded reply. */
	threadTs: string | null;
}

// `https://<workspace>.slack.com/archives/<C…>/p<16+ digits>`. The digits are
// the message ts with its decimal point removed.
const PERMALINK_RE =
	/^https?:\/\/([a-z0-9][a-z0-9-]*)\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10,})/i;

/**
 * Split a Slack permalink into its parts, or `null` if it isn't one.
 *
 * Deliberately strict: the field is explicitly "a link to a Slack message", and
 * accepting arbitrary URLs would both make the stored channel/ts columns
 * meaningless and let pasted junk end up in a DM sent to a member.
 */
export function parseSlackMessageLink(raw: string): SlackMessageRef | null {
	const url = raw.trim();
	if (url === '') return null;

	const match = PERMALINK_RE.exec(url);
	if (!match) return null;

	const channelId = match[2]!;
	const digits = match[3]!;
	// Slack's `p` form is the ts with the dot removed, and the fractional part
	// is always the last 6 digits.
	const ts = `${digits.slice(0, -6)}.${digits.slice(-6)}`;

	let threadTs: string | null;
	try {
		threadTs = new URL(url).searchParams.get('thread_ts');
	} catch {
		// The regex already matched, so this should be unreachable; a malformed
		// query string simply means "not a threaded link".
		threadTs = null;
	}

	return { url, channelId, ts, threadTs };
}

export interface PermalinkParts {
	/** `payload.team.domain` — the workspace subdomain, without `.slack.com`. */
	teamDomain: string | null | undefined;
	channelId: string | null | undefined;
	ts: string | null | undefined;
	/** Present on a threaded reply; produces the `?thread_ts=…&cid=…` suffix. */
	threadTs?: string | null;
}

/**
 * Assemble a permalink from the pieces a `message_action` payload already
 * carries. Returns `null` when anything essential is missing — the caller then
 * opens the modal with a blank link field rather than delaying it to call
 * `chat.getPermalink`.
 */
export function buildSlackPermalink(parts: PermalinkParts): string | null {
	const { teamDomain, channelId, ts, threadTs } = parts;
	if (!teamDomain || !channelId || !ts) return null;

	const base = `https://${teamDomain}.slack.com/archives/${channelId}/p${ts.replace('.', '')}`;
	// Slack's own "Copy link" on a threaded reply appends both params; without
	// them the link opens the channel rather than the thread.
	if (threadTs && threadTs !== ts) {
		return `${base}?thread_ts=${encodeURIComponent(threadTs)}&cid=${encodeURIComponent(channelId)}`;
	}
	return base;
}

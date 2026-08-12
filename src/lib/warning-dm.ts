// Renders the DM a member receives when an admin logs a warning against them.
// Mirrors welcome-dm.ts: the template is admin-editable on /settings, stored
// raw with friendly `#channel-name` tokens, and resolved at send time.
//
// Three substitutions on top of that, all all-or-nothing so a missing value can
// never leave a dangling fragment in a message a real person reads:
//
//   {{nth}}          → the ordinal ("first", "second", "11th")
//   {{note}}         → the admin's note body, blockquoted
//   {{message_link}} → "This is regarding: <url>" — the *whole clause*, not a
//                      bare URL, so a warning with no linked message doesn't
//                      render "This is regarding:" followed by nothing.
//
// The admin can also override the rendered text per-warning in the Slack modal;
// that override is passed here as `template`, so an edited warning goes through
// exactly the same substitution and channel-link resolution as the default.

import { ordinal } from './ordinal.js';
import { extractChannelNames, resolveChannelLinks } from './channel-tokens.js';

/** Used when no template is configured. Deliberately opens with the ordinal —
 *  the whole point of numbering warnings is that the member knows where they
 *  stand. */
export const DEFAULT_WARNING_DM =
	'This is your {{nth}} warning from the moderation team.\n\n' +
	'{{note}}\n' +
	'{{message_link}}\n\n' +
	'Please take a moment to re-read the community guidelines. ' +
	'Repeated warnings may result in being removed from the workspace.';

/** Every token the template may contain, for validation. */
const KNOWN_TOKENS = ['nth', 'note', 'message_link'] as const;

const TOKEN_RE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

export interface WarningDmContext {
	/** All-time warning count for this member, 1-based. */
	warningNumber: number;
	/** The admin's note body. */
	noteBody: string;
	/** Permalink to the message the warning is about, when there is one. */
	messageLink: string | null;
}

/** Prefix each line so the note reads as a quotation rather than as the bot
 *  speaking. Blank lines get a bare `>` so Slack keeps one quote block. */
function blockquote(text: string): string {
	return text
		.trim()
		.split('\n')
		.map((line) => `> ${line}`.trimEnd())
		.join('\n');
}

/** Collapse 3+ consecutive newlines to 2 and trim. Any token that expanded to
 *  '' leaves an empty line behind; without this the message arrives with
 *  ragged gaps. */
function collapseBlankLines(text: string): string {
	return text.replace(/\n{3,}/g, '\n\n').trim();
}

const REGARDING_PREFIX = 'This is regarding: ';

/**
 * Render the final DM body. Falls back to the built-in default when the
 * template is blank, substitutes the three tokens, then resolves `#channel`
 * names last — same ordering discipline as `renderWelcomeDm`, so a `#name`
 * inside a substituted note body is still linkified but nothing is processed
 * twice.
 */
export function renderWarningDm(
	template: string,
	ctx: WarningDmContext,
	nameToId: ReadonlyMap<string, string>,
): string {
	const body = template.trim() || DEFAULT_WARNING_DM;
	const link = ctx.messageLink?.trim() ?? '';

	let out = body
		.replaceAll('{{nth}}', ordinal(ctx.warningNumber))
		.replaceAll('{{note}}', ctx.noteBody.trim() ? blockquote(ctx.noteBody) : '')
		.replaceAll('{{message_link}}', link ? `${REGARDING_PREFIX}${link}` : '');

	// A link was captured but the template has nowhere to put it. Dropping it
	// silently is the worse failure — the admin deliberately attached it — so
	// append rather than discard.
	if (link && !body.includes('{{message_link}}')) {
		out += `\n\n${REGARDING_PREFIX}${link}`;
	}

	return resolveChannelLinks(collapseBlankLines(out), nameToId);
}

export type WarningTemplateValidation =
	{ ok: true; channelNames: string[] } | { ok: false; error: string };

/**
 * Save-time validation for the /settings editor, mirroring the welcome-DM
 * `#channel` check. Returns the referenced channel names so the endpoint can
 * verify them against the live channel list.
 *
 * `{{nth}}` is required: a warning that doesn't tell the member which number
 * they're on defeats the purpose of numbering them, and it's much cheaper to
 * catch a dropped token here than after it has gone out to someone.
 */
export function validateWarningTemplate(template: string): WarningTemplateValidation {
	const trimmed = template.trim();
	// Empty means "use the built-in default", which contains every token.
	if (trimmed === '') return { ok: true, channelNames: [] };

	const used = new Set<string>();
	for (const match of trimmed.matchAll(TOKEN_RE)) used.add(match[1]!.toLowerCase());

	// Catches `{{Nth}}` and `{{nth }}` too — the replace above is an exact
	// literal match, so those would ship to a member as raw braces.
	const unknown = [...used].filter(
		(t) => !(KNOWN_TOKENS as readonly string[]).includes(t as (typeof KNOWN_TOKENS)[number]),
	);
	if (unknown.length > 0) {
		return {
			ok: false,
			error: `Unknown token(s): ${unknown.map((t) => `{{${t}}}`).join(', ')}. Available: ${KNOWN_TOKENS.map((t) => `{{${t}}}`).join(', ')}`,
		};
	}

	if (!trimmed.includes('{{nth}}')) {
		return {
			ok: false,
			error:
				'The warning message must include {{nth}} so the member is told which warning this is.',
		};
	}

	return { ok: true, channelNames: extractChannelNames(trimmed) };
}

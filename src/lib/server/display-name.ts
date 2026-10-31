// Display names for volunteers who signed in outside Slack — shared by the
// Google and Apple sign-ins and the name box on /turfs (specs/014-apple-sso-login,
// FR-010 and FR-011).

/** Longest display name kept. Generous for a real name; short enough that a
 *  profile name cannot fill a Slack message or a spreadsheet cell. */
export const MAX_DISPLAY_NAME = 64;

/**
 * Everything invisible, by Unicode category rather than a hand-kept list:
 * control characters (Cc), format characters (Cf: bidi controls, zero-width
 * characters, the soft hyphen, tag characters), and line and paragraph
 * separators. Plus the characters that are not in those categories but still
 * draw nothing: the Hangul fillers, the braille blank and the variation
 * selectors. None belongs in a name, and the bidi ones can make a name read
 * differently from what it is.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Variation_Selector}\u115f\u1160\u3164\u2800]/gu;

/** The characters Slack mrkdwn formats with. Escaping `& < >` cannot stop
 *  them, and a real name does not need them. */
const SLACK_FORMATTING = /[*_~`]/g;

/**
 * Something Slack might auto-link: a scheme, a domain in any script, or an
 * IPv4 address. Deliberately broad: a real name rarely has a dot with no space
 * after it, and one that does only gains a `\u00b7`.
 */
const LOOKS_LIKE_LINK = /:\/\/|[\p{L}\p{N}-]+\.\p{L}{2,}|\d{1,3}(?:\.\d{1,3}){3}/u;

/**
 * What the app calls a volunteer who signed in outside Slack. It labels the
 * session and is the holder name stamped on their claims — and from there it
 * reaches Slack posts and the campaign's spreadsheets. It comes from a Google
 * profile, Apple's first-sign-in `user` field, or the box on /turfs, so any
 * stranger chooses it, and it is tidied here, once:
 *
 *   - Invisible and control characters (newlines included) become spaces and
 *     whitespace collapses, so a name is always one plain line.
 *   - Slack's formatting characters are dropped, and anything Slack would turn
 *     into a live link is defanged (`https://evil.example` →
 *     `https evil·example`), so the bot never posts a link a volunteer chose.
 *   - It is capped at MAX_DISPLAY_NAME characters — counted by code point, so
 *     the cut never splits one in half.
 *
 * The Slack sinks still escape `& < >` themselves; this is the part escaping
 * cannot do.
 *
 * Returns '' when nothing usable is left. The caller decides what that means
 * — for a sign-in, that /turfs asks for a name. Never fall back to part of the
 * email: that would put an identifier for them into Slack and the spreadsheets
 * that the privacy policy says the email never reaches.
 */
export function tidyDisplayName(raw: string): string {
	let tidy = raw.replace(INVISIBLE, ' ').replace(SLACK_FORMATTING, ' ');
	if (LOOKS_LIKE_LINK.test(tidy)) tidy = tidy.replace(/:\/\//g, ' ').replace(/\./g, '·');
	tidy = tidy.replace(/\s+/g, ' ').trim();
	return Array.from(tidy).slice(0, MAX_DISPLAY_NAME).join('').trim();
}

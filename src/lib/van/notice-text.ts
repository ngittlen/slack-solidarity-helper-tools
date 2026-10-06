// A holder DM, reshaped for showing on /turfs instead of in Slack.
//
// The messages are written once, as Slack mrkdwn, by the renderers in
// expiry-warning.ts, door-delta.ts and refresh-reconcile.ts. A Google or Apple
// volunteer sees the same words on the page (specs/013-google-sso-login and
// specs/014-apple-sso-login, User Story 5),
// so rather than a second set of renderers that would drift from the first,
// this turns the small subset of mrkdwn they use into plain segments the page
// renders as text — never as HTML, so nothing in a turf name can become markup.
//
// The subset: a leading `:emoji:` (dropped), `*bold*`, `<url|label>` links, and
// Slack's three escapes. A link is kept only when it points into this app —
// they all do today — and otherwise shows as its label.

export interface NoticeSegment {
	text: string;
	bold?: true;
	/** Same-site path, already checked. */
	href?: string;
}

/** One line of a notice; an empty array is a paragraph break. */
export type NoticeLine = NoticeSegment[];

const TOKEN = /<([^|>]+)\|([^>]+)>|\*([^*\n]+)\*/g;

function unescape(raw: string): string {
	return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** `url` as a same-site path when it is one of ours, else null. */
function ownPath(url: string, appUrl: string): string | null {
	const target = unescape(url);
	let parsed: URL;
	try {
		parsed = new URL(target, appUrl);
	} catch {
		return null;
	}
	if (parsed.origin !== new URL(appUrl).origin) return null;
	// Same origin can still yield `//host/…` (from `APP_URL//host`), which a
	// browser follows as a link to another site. The same rule as
	// sanitizeRedirectTarget: a rooted path, never a protocol-relative one.
	const path = parsed.pathname + parsed.search;
	if (path.startsWith('//') || path.startsWith('/\\')) return null;
	return path;
}

/** Split one mrkdwn line into segments. */
function parseLine(line: string, appUrl: string): NoticeLine {
	const segments: NoticeLine = [];
	let last = 0;
	for (const m of line.matchAll(TOKEN)) {
		if (m.index > last) segments.push({ text: unescape(line.slice(last, m.index)) });
		if (m[1] !== undefined && m[2] !== undefined) {
			const href = ownPath(m[1], appUrl);
			segments.push(href ? { text: unescape(m[2]), href } : { text: unescape(m[2]) });
		} else if (m[3] !== undefined) {
			segments.push({ text: unescape(m[3]), bold: true });
		}
		last = m.index + m[0].length;
	}
	if (last < line.length) segments.push({ text: unescape(line.slice(last)) });
	return segments;
}

/**
 * The lines of a notice, ready to render. `appUrl` decides which links are
 * ours. Runs of blank lines collapse to one break, and none lead or trail.
 */
export function noticeLines(mrkdwn: string, appUrl: string): NoticeLine[] {
	const lines = mrkdwn
		.replace(/^:[a-z0-9_+-]+:\s*/, '')
		.split('\n')
		.map((line) => parseLine(line, appUrl));

	const out: NoticeLine[] = [];
	for (const line of lines) {
		const blank = line.length === 0 || line.every((s) => s.text.trim() === '');
		if (blank) {
			if (out.length > 0 && out[out.length - 1]!.length > 0) out.push([]);
		} else {
			out.push(line);
		}
	}
	while (out.length > 0 && out[out.length - 1]!.length === 0) out.pop();
	return out;
}

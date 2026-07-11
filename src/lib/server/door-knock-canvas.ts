// Reads the "Conversation Codes" canvas from the door-knocking Slack channel
// and extracts (conversation code, chapter) pairs for the nightly door-knock
// snapshot.
//
// The canvas (a Slack quip document, downloaded as HTML) has two code layouts:
//   1. Chapter sections — a shouted heading line naming the chapter
//      ("DETROIT", "WAYNE CHAPTER - PRIORITY CITIES", "LANSING CHAPTER
//      (Clinton County, …)") followed by "LABEL - CODE" / "LABEL: CODE"
//      lines (list items or bare paragraphs — editors switch freely).
//   2. A <table> with CHAPTER | COUNTIES IN CHAPTER | CODE rows, where the
//      chapter cell is blank on continuation rows (carried forward) and the
//      same code repeats across a chapter's counties.
// Training/practice and voter-lookup-only codes are listed too and must be
// excluded — their surrounding text says "practice"/"training"/"lookup".
//
// Canvas edits are human and unpredictable — observed drift includes headers
// gaining parentheticals, list items becoming paragraphs, and stray
// annotation text landing INSIDE a code's bold tag ("662DZC>>[ppi:"). So the
// non-table pass is line-based rather than element-structural: block-level
// tags delimit lines, short ALL-CAPS lines set the current chapter, and any
// "LABEL sep CODE" line under it counts, tolerating trailing junk. A code is
// exactly 6 chars of A-Z0-9 (real codes can be all letters, e.g. QUJAUF).
// Callers treat "zero codes parsed" as an error.
//
// No $env/$lib imports — the Slack token and fetch are injected (same
// discipline as solidarity.ts) so tests run without a network.

export interface ConversationCode {
	code: string;
	chapter: string;
}

// Exactly 6 uppercase alphanumerics. No digit requirement — real codes can
// be all letters (QUJAUF, AAPUVM). Both layouts only test tokens in
// code-position (a table's last cell, a list item's trailing token), which is
// what keeps ordinary 6-letter words like COUNTY out.
const CODE_RE = /^[A-Z0-9]{6}$/;
// "practice"/"training" marks the tutorial code; "lookup" covers both
// phrasings of the voter-lookup-only street-canvass code ("VOTER LOOKUP
// ONLY", "Voter lookup and match only").
const EXCLUDED_CONTEXT_RE = /practice|training|lookup/i;

function stripTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** "WAYNE CHAPTER - PRIORITY CITIES" → "Wayne", "LANSING CHAPTER (…)" →
 *  "Lansing", "OAKLAND COUNTY" → "Oakland", "DETROIT" → "Detroit". */
function chapterFromHeading(line: string): string {
	let head = line.replace(/\(.*$/, '').trim();
	const beforeChapter = /^(.*?)\s+CHAPTER\b/.exec(head)?.[1];
	if (beforeChapter) {
		head = beforeChapter;
	} else {
		head = head.replace(/\s+(CITIES|COUNTIES|COUNTY)\s*$/i, '');
	}
	return head.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Chapter headings are short shouted lines ("DETROIT", "KENT CHAPTER") —
 *  possibly with a lowercase parenthetical tail ("LANSING CHAPTER (Clinton
 *  County, …)"). Long all-caps prose and "…CODES…" banners don't qualify. */
function isChapterHeading(line: string): boolean {
	// A trailing separator means a code label whose code is missing/removed
	// ("GRAND RAPIDS WARD 1 (WEST) -"), not a heading.
	if (/[:\-–—]\s*$/.test(line.trim())) return false;
	const head = line.replace(/\(.*$/, '').trim();
	if (!head || head.length > 60) return false;
	if (/[a-z]/.test(head) || !/[A-Z]/.test(head)) return false;
	if (/\bCODES?\b/.test(head)) return false;
	if (EXCLUDED_CONTEXT_RE.test(head)) return false;
	return true;
}

function parseTableCodes(html: string, out: ConversationCode[]): void {
	for (const [, tableHtml] of html.matchAll(/<table>([\s\S]*?)<\/table>/g)) {
		let carriedChapter = '';
		for (const [, rowHtml] of tableHtml!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
			const cells = [...rowHtml!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]!));
			if (cells.length < 2) continue;
			const code = cells[cells.length - 1]!;
			if (!CODE_RE.test(code)) continue; // header row, blank row, …
			carriedChapter = cells[0] || carriedChapter;
			if (EXCLUDED_CONTEXT_RE.test(cells.slice(0, -1).join(' '))) continue;
			if (!carriedChapter) continue;
			out.push({ code, chapter: carriedChapter });
		}
	}
}

// "LABEL - CODE" / "LABEL: CODE" with optional trailing junk that isn't
// uppercase-alphanumeric (stray annotation text has been observed right after
// a code: "DEARBORN HEIGHTS: 662DZC>>[ppi:").
const LABELED_CODE_RE = /[:\-–—]\s*([A-Z0-9]{6})(?![A-Z0-9])[^A-Z0-9]*$/;

function parseLabeledLineCodes(html: string, out: ConversationCode[]): void {
	// Tables are handled by parseTableCodes with real chapter cells — strip
	// them so this pass can't double-attribute their codes.
	const withoutTables = html.replace(/<table>[\s\S]*?<\/table>/g, ' ');
	const lines = withoutTables
		.split(/<\/p>|<\/li>|<\/h[1-6]>|<br\s*\/?>/)
		.map(stripTags)
		.filter(Boolean);

	let chapter = '';
	for (const line of lines) {
		const code = LABELED_CODE_RE.exec(line)?.[1];
		if (code && CODE_RE.test(code)) {
			if (chapter && !EXCLUDED_CONTEXT_RE.test(line)) {
				out.push({ code, chapter });
			}
			continue;
		}
		if (isChapterHeading(line)) chapter = chapterFromHeading(line);
	}
}

// Codes whose IMMEDIATE surroundings carry excluded wording — e.g. the
// "( CODE - for practice only! - XXXXXX)" paragraph, or "STREET CANVASSING
// CODE - XXXXXX (Voter lookup…)" — are banned globally, so they stay out even
// if they also appear in a structured spot. The window is deliberately tight:
// in the table, the lookup-only row sits directly above real rows, and a wide
// window would poison those neighbors.
function bannedCodes(text: string): Set<string> {
	const banned = new Set<string>();
	for (const match of text.matchAll(/(?<![A-Z0-9])[A-Z0-9]{6}(?![A-Z0-9])/g)) {
		const code = match[0];
		if (!CODE_RE.test(code)) continue;
		const context = text.slice(Math.max(0, match.index - 30), match.index + 36);
		if (EXCLUDED_CONTEXT_RE.test(context)) banned.add(code);
	}
	return banned;
}

/** Every code-SHAPED token in the canvas text, minus the practice/lookup
 *  bans — deliberately structure-free, so it keeps working when the layout
 *  changes. Includes ordinary 6-letter uppercase words (COUNTY, CITIES, …):
 *  the snapshot's completeness check separates words from real codes by
 *  asking Openfield, which resolves codes and 404s words. Anything that
 *  resolves but wasn't attributed by parseConversationCodes means the canvas
 *  layout drifted past the parser. */
export function findCandidateCodes(html: string): string[] {
	const text = stripTags(html);
	const banned = bannedCodes(text);
	const candidates = new Set<string>();
	for (const match of text.matchAll(/(?<![A-Za-z0-9])[A-Z0-9]{6}(?![A-Za-z0-9])/g)) {
		if (CODE_RE.test(match[0]) && !banned.has(match[0])) candidates.add(match[0]);
	}
	return [...candidates].sort();
}

/** Extract unique (code, chapter) pairs from the canvas HTML. Codes whose
 *  surrounding text marks them as practice/training or lookup-only are
 *  excluded everywhere they appear. */
export function parseConversationCodes(html: string): ConversationCode[] {
	const found: ConversationCode[] = [];
	parseTableCodes(html, found);
	parseLabeledLineCodes(html, found);

	const banned = bannedCodes(stripTags(html));

	const byCode = new Map<string, ConversationCode>();
	for (const entry of found) {
		if (banned.has(entry.code)) continue;
		if (!byCode.has(entry.code)) byCode.set(entry.code, entry);
	}
	return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

type FetchFn = typeof fetch;

interface SlackApiEnvelope {
	ok: boolean;
	error?: string;
}

async function slackApi<T extends SlackApiEnvelope>(
	fetchFn: FetchFn,
	token: string,
	method: string,
	params: Record<string, string>,
): Promise<T> {
	const qs = new URLSearchParams(params);
	const res = await fetchFn(`https://slack.com/api/${method}?${qs}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const body = (await res.json()) as T;
	if (!body.ok) throw new Error(`slack ${method} failed: ${body.error ?? 'unknown error'}`);
	return body;
}

const CANVAS_TITLE = 'conversation codes';

/** Locate the "Conversation Codes" canvas among the channel's canvas tabs and
 *  download its HTML. Throws with a descriptive message on any miss. */
export async function fetchConversationCodesCanvas(
	slackToken: string,
	channelId: string,
	fetchFn: FetchFn = fetch,
): Promise<string> {
	const info = await slackApi<
		SlackApiEnvelope & {
			channel?: { properties?: { tabs?: Array<{ type: string; data?: { file_id?: string } }> } };
		}
	>(fetchFn, slackToken, 'conversations.info', { channel: channelId });

	const fileIds = (info.channel?.properties?.tabs ?? [])
		.filter((t) => t.type === 'canvas' && t.data?.file_id)
		.map((t) => t.data!.file_id!);
	if (fileIds.length === 0) {
		throw new Error(`no canvas tabs found in channel ${channelId}`);
	}

	for (const fileId of fileIds) {
		const file = await slackApi<
			SlackApiEnvelope & { file?: { title?: string; url_private?: string } }
		>(fetchFn, slackToken, 'files.info', { file: fileId });
		if (file.file?.title?.trim().toLowerCase() !== CANVAS_TITLE) continue;
		const url = file.file.url_private;
		if (!url) throw new Error(`canvas ${fileId} has no url_private`);
		const res = await fetchFn(url, { headers: { Authorization: `Bearer ${slackToken}` } });
		if (!res.ok) throw new Error(`canvas download failed with HTTP ${res.status}`);
		return res.text();
	}
	throw new Error(`no canvas titled "Conversation Codes" in channel ${channelId}`);
}

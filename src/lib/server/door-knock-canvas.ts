// Reads the "Conversation Codes" canvas from the door-knocking Slack channel
// and extracts (conversation code, chapter) pairs for the nightly door-knock
// snapshot.
//
// The canvas (a Slack quip document, downloaded as HTML) has two code layouts:
//   1. Metro sections — a bold header paragraph naming the chapter/metro
//      (DETROIT, WAYNE CITIES, KENT COUNTY, …) followed by a <ul> whose items
//      read "LABEL - CODE" or "LABEL: CODE".
//   2. A <table> with CHAPTER | COUNTIES IN CHAPTER | CODE rows, where the
//      chapter cell is blank on continuation rows (carried forward) and the
//      same code repeats across a chapter's counties.
// Training/practice and voter-lookup-only codes are listed too and must be
// excluded — their surrounding text says "practice"/"training"/"lookup only".
//
// Canvas edits are human and unpredictable, so the parser is tolerant: it
// takes anything matching the code shape (exactly 6 chars of A-Z0-9 — real
// codes can be all letters, e.g. QUJAUF) in either layout, and callers treat
// "zero codes parsed" as an error.
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

/** "WAYNE CITIES" → "Wayne", "OAKLAND COUNTY" → "Oakland", "DETROIT" →
 *  "Detroit" — matches the chapter names used in the canvas table. */
function chapterFromHeader(header: string): string {
	const bare = header
		.trim()
		.replace(/\s+(CITIES|COUNTIES|COUNTY)\s*$/i, '')
		.toLowerCase();
	return bare.replace(/\b[a-z]/g, (c) => c.toUpperCase());
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

function parseMetroSectionCodes(html: string, out: ConversationCode[]): void {
	// A bold header paragraph immediately followed by a list block.
	const sectionRe = /<p[^>]*>\s*<b>([^<]+)<\/b>\s*<\/p>\s*<div[^>]*>\s*<ul[\s\S]*?<\/ul>\s*<\/div>/g;
	for (const [sectionHtml, header] of html.matchAll(sectionRe)) {
		const chapter = chapterFromHeader(stripTags(header!));
		if (!chapter || EXCLUDED_CONTEXT_RE.test(header!)) continue;
		for (const [, itemHtml] of sectionHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
			const text = stripTags(itemHtml!);
			if (EXCLUDED_CONTEXT_RE.test(text)) continue;
			const code = /(?<![A-Z0-9])([A-Z0-9]{6})\s*$/.exec(text)?.[1];
			if (code && CODE_RE.test(code)) out.push({ code, chapter });
		}
	}
}

/** Extract unique (code, chapter) pairs from the canvas HTML. Codes whose
 *  surrounding text marks them as practice/training or lookup-only are
 *  excluded everywhere they appear. */
export function parseConversationCodes(html: string): ConversationCode[] {
	const found: ConversationCode[] = [];
	parseTableCodes(html, found);
	parseMetroSectionCodes(html, found);

	// Codes whose IMMEDIATE surroundings carry excluded wording — e.g. the
	// "( CODE - for practice only! - XXXXXX)" paragraph, or "STREET CANVASSING
	// CODE - XXXXXX (Voter lookup…)" — are banned globally, so they stay out
	// even if they also appear in a structured spot. The window is deliberately
	// tight: in the table, the lookup-only row sits directly above real rows,
	// and a wide window would poison those neighbors.
	const banned = new Set<string>();
	const text = stripTags(html);
	for (const match of text.matchAll(/(?<![A-Z0-9])[A-Z0-9]{6}(?![A-Z0-9])/g)) {
		const code = match[0];
		if (!CODE_RE.test(code)) continue;
		const context = text.slice(Math.max(0, match.index - 30), match.index + 36);
		if (EXCLUDED_CONTEXT_RE.test(context)) banned.add(code);
	}

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

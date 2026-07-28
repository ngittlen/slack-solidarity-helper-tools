import { describe, it, expect, vi } from 'vitest';
import {
	parseConversationCodes,
	findCandidateCodes,
	fetchConversationCodesCanvas,
} from './door-knock-canvas.js';

// Condensed from real "Conversation Codes" canvas HTML across its observed
// revisions: shouted chapter headings (bare, with a "CHAPTER - …" tail, or
// with a lowercase parenthetical), "LABEL: CODE" lines as list items, the
// chapter/county/code <table> with carry-forward chapter cells, a practice
// code, the voter-lookup-only code (in BOTH layouts), plus real-world damage:
// annotation garbage inside a code's bold tag, a corrupted label, and a
// label whose code was deleted.
const CANVAS_FIXTURE = `<div class="quip-canvas-content"><h1 id="a">Conversation Codes</h1>
<p id="b" class="line">( CODE - for practice only! - 26VKY9)</p>
<h2 id="c">Priority Metros - Always knock in these places if at all possible!</h2>
<div data-section-style='6' class="list-numbering-restart-at"><ul id='d'><li id='e' value='1'><span id="e"><b>Bay</b></span><br/></li><ul><li id='f'><span id="f">Bay City</span><br/></li></ul></ul></div>
<p id="g" class="line"><b>STREET CANVASSING CODE - MYU5PV</b><br>(Voter lookup and match only - no knock list)</p>
<h2 id="h"><b>CHAPTERS WITH LARGE METROPOLITAN CENTERS - PLEASE FIND CITY CODES IMMEDIATELY BELOW ALL OTHER CHAPTERS LISTED IN THE TABLE</b></h2>
<p id="i" class="line"><b>WAYNE CHAPTER - PRIORITY CITIES</b></p><div data-section-style='6'><ul id='j'><li id='k' value='1'><span id="k">DETROIT WARD 1 (NORTHWEST): <b>CH25Z9</b></span><br/></li><li id='l'><span id="l">DEARBORN HEIGHTS: <b>662DZC&gt;&gt;[ppi:</b></span><br/></li><li id='m'><span id="m">GROSSE POINTEpi i upping PARK:  <b>CTQQ3H</b></span><br/></li></ul></div>
<p id="n" class="line"><b>KENT CHAPTER</b></p><div data-section-style='6'><ul id='o'><li id='p' value='1'><span id="p">GRAND RAPIDS WARD 1 (WEST) -</span><br/></li><li id='q'><span id="q">GRAND RAPIDS WARD 2 (NORTHEAST) - <b>79Z423</b></span><br/></li></ul></div>
<p id="r" class="line"><b>LANSING CHAPTER </b>(Clinton County,<b> </b>Eaton County, Ingham County)</p><div data-section-style='6'><ul id='s'><li id='t' value='1'><span id="t">LANSING CITY - <b>SZF2QF</b></span><br/></li></ul></div>
<table><tr><td><p id="u" class="line"><b>CHAPTER</b></p></td><td><p id="v" class="line"><b>COUNTIES IN CHAPTER</b></p></td><td><p id="w" class="line"><b>CODE</b></p></td></tr>
<tr><td><p id="x" class="line">STREET CANVASS</p></td><td><p id="y" class="line">(VOTER LOOKUP ONLY)</p></td><td><p id="z" class="line">MYU5PV</p></td></tr>
<tr><td><p id="aa">Allegan</p></td><td><p id="ab">Allegan County</p></td><td><p id="ac" class="line">4UNW8F</p></td></tr>
<tr><td><p id="ad"></p></td><td><p id="ae">Barry County</p></td><td><p id="af" class="line">4UNW8F</p></td></tr>
<tr><td><p id="ag">Washtenaw ANN ARBOR</p></td><td><p id="ah">Washtenaw County</p></td><td><p id="ai" class="line">NHBNTW</p></td></tr></table></div>`;

describe('parseConversationCodes', () => {
	it('extracts table and heading-section codes with their chapters', () => {
		expect(parseConversationCodes(CANVAS_FIXTURE)).toEqual([
			{ code: '4UNW8F', chapter: 'Allegan' },
			{ code: '662DZC', chapter: 'Wayne' },
			{ code: '79Z423', chapter: 'Kent' },
			{ code: 'CH25Z9', chapter: 'Wayne' },
			{ code: 'CTQQ3H', chapter: 'Wayne' },
			{ code: 'NHBNTW', chapter: 'Washtenaw ANN ARBOR' },
			{ code: 'SZF2QF', chapter: 'Lansing' },
		]);
	});

	it('excludes the practice code and the lookup-only code in both layouts', () => {
		const codes = parseConversationCodes(CANVAS_FIXTURE).map((c) => c.code);
		expect(codes).not.toContain('26VKY9');
		expect(codes).not.toContain('MYU5PV');
	});

	it('carries the chapter forward across blank table cells and dedupes shared codes', () => {
		const allegan = parseConversationCodes(CANVAS_FIXTURE).filter((c) => c.code === '4UNW8F');
		expect(allegan).toEqual([{ code: '4UNW8F', chapter: 'Allegan' }]);
	});

	it('normalizes headings: CHAPTER tails and parentheticals dropped', () => {
		const byCode = new Map(parseConversationCodes(CANVAS_FIXTURE).map((c) => [c.code, c.chapter]));
		expect(byCode.get('CH25Z9')).toBe('Wayne'); // "WAYNE CHAPTER - PRIORITY CITIES"
		expect(byCode.get('SZF2QF')).toBe('Lansing'); // "LANSING CHAPTER (Clinton County, …)"
		expect(byCode.get('79Z423')).toBe('Kent'); // "KENT CHAPTER"
	});

	it('tolerates annotation garbage after a code and corrupted labels', () => {
		const byCode = new Map(parseConversationCodes(CANVAS_FIXTURE).map((c) => [c.code, c.chapter]));
		expect(byCode.get('662DZC')).toBe('Wayne'); // "662DZC>>[ppi:"
		expect(byCode.get('CTQQ3H')).toBe('Wayne'); // "GROSSE POINTEpi i upping PARK:"
	});

	it('does not mistake a code-deleted label line for a chapter heading', () => {
		// "GRAND RAPIDS WARD 1 (WEST) -" must not hijack the KENT CHAPTER heading.
		const byCode = new Map(parseConversationCodes(CANVAS_FIXTURE).map((c) => [c.code, c.chapter]));
		expect(byCode.get('79Z423')).toBe('Kent');
	});

	it('ignores non-6-char tokens and returns [] for codeless HTML', () => {
		expect(
			parseConversationCodes('<p><b>HEADER</b></p><div><ul><li>WARD 12 - ABC1234</li></ul></div>'),
		).toEqual([]);
		expect(parseConversationCodes('')).toEqual([]);
	});
});

describe('findCandidateCodes', () => {
	it('collects every code-shaped token regardless of layout, minus practice/lookup bans', () => {
		const candidates = findCandidateCodes(CANVAS_FIXTURE);
		// Everything the structured parser finds is a candidate too…
		for (const { code } of parseConversationCodes(CANVAS_FIXTURE)) {
			expect(candidates).toContain(code);
		}
		// …as are ordinary 6-letter uppercase words — the snapshot separates
		// words from codes by asking Openfield (words 404).
		expect(candidates).toContain('CITIES');
		// Banned codes stay out even of the structure-free scan.
		expect(candidates).not.toContain('26VKY9');
		expect(candidates).not.toContain('MYU5PV');
	});

	it('finds codes the structured parser cannot attribute (the drift signal)', () => {
		// A code dropped into a bare paragraph with no label separator and no
		// heading — unparseable, but still a candidate.
		const html = CANVAS_FIXTURE.replace('<table>', '<p id="zz">new code ZZ9ZZ9</p><table>');
		const parsed = parseConversationCodes(html).map((c) => c.code);
		expect(parsed).not.toContain('ZZ9ZZ9');
		expect(findCandidateCodes(html)).toContain('ZZ9ZZ9');
	});
});

describe('fetchConversationCodesCanvas', () => {
	function jsonRes(body: unknown) {
		return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
	}

	function makeFetch() {
		return vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('conversations.info')) {
				return jsonRes({
					ok: true,
					channel: {
						// Slack returns the tab bar under `tabz` (observed 2026-07).
						properties: {
							tabz: [
								{ type: 'canvas', data: { file_id: 'F_OTHER' } },
								{ type: 'files', data: {} },
								{ type: 'canvas', data: { file_id: 'F_CODES' } },
							],
						},
					},
				});
			}
			if (url.includes('files.info?file=F_OTHER') || url.includes('file=F_OTHER')) {
				return jsonRes({
					ok: true,
					file: { title: 'Using Openfield', url_private: 'https://dl/other' },
				});
			}
			if (url.includes('file=F_CODES')) {
				return jsonRes({
					ok: true,
					file: { title: ' Conversation Codes ', url_private: 'https://dl/codes' },
				});
			}
			if (url === 'https://dl/codes') {
				return { ok: true, text: async () => CANVAS_FIXTURE, json: async () => ({}) };
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as unknown as typeof fetch;
	}

	it('finds the canvas by title (case/whitespace-insensitive) and downloads it', async () => {
		const html = await fetchConversationCodesCanvas('xoxb-test', 'C_DOOR', makeFetch());
		expect(html).toBe(CANVAS_FIXTURE);
	});

	it('reads canvas tabs from the legacy `tabs` field too', async () => {
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('conversations.info')) {
				return jsonRes({
					ok: true,
					channel: { properties: { tabs: [{ type: 'canvas', data: { file_id: 'F_CODES' } }] } },
				});
			}
			if (url.includes('file=F_CODES')) {
				return jsonRes({
					ok: true,
					file: { title: 'Conversation Codes', url_private: 'https://dl/codes' },
				});
			}
			if (url === 'https://dl/codes') {
				return { ok: true, text: async () => CANVAS_FIXTURE, json: async () => ({}) };
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as unknown as typeof fetch;
		const html = await fetchConversationCodesCanvas('xoxb-test', 'C_DOOR', fetchFn);
		expect(html).toBe(CANVAS_FIXTURE);
	});

	it('throws when no canvas has the expected title', async () => {
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('conversations.info')) {
				return {
					ok: true,
					json: async () => ({
						ok: true,
						channel: { properties: { tabs: [{ type: 'canvas', data: { file_id: 'F1' } }] } },
					}),
				};
			}
			return { ok: true, json: async () => ({ ok: true, file: { title: 'Notes' } }) };
		}) as unknown as typeof fetch;
		await expect(fetchConversationCodesCanvas('xoxb-test', 'C_DOOR', fetchFn)).rejects.toThrow(
			/no canvas titled/,
		);
	});

	it('throws when the channel has no canvas tabs', async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			json: async () => ({ ok: true, channel: { properties: {} } }),
		})) as unknown as typeof fetch;
		await expect(fetchConversationCodesCanvas('xoxb-test', 'C_DOOR', fetchFn)).rejects.toThrow(
			/no canvas tabs/,
		);
	});

	it('surfaces Slack API errors with the method name', async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			json: async () => ({ ok: false, error: 'missing_scope' }),
		})) as unknown as typeof fetch;
		await expect(fetchConversationCodesCanvas('xoxb-test', 'C_DOOR', fetchFn)).rejects.toThrow(
			/conversations.info failed: missing_scope/,
		);
	});
});

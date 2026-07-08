import { describe, it, expect, vi } from 'vitest';
import { parseConversationCodes, fetchConversationCodesCanvas } from './door-knock-canvas.js';

// Condensed from the real "Conversation Codes" canvas HTML: metro sections
// (bold header + <ul> of "LABEL: CODE" items), the chapter/county/code
// <table> with carry-forward chapter cells, a practice code, and the
// voter-lookup-only street-canvass code (which appears in BOTH layouts).
const CANVAS_FIXTURE = `<div class="quip-canvas-content"><h1 id="a">Conversation Codes</h1>
<p id="b" class="line">( CODE - for practice only! - 26VKY9)</p>
<h2 id="c">Priority Metros - Always knock in these places if at all possible!</h2>
<div data-section-style='6' class="list-numbering-restart-at"><ul id='d'><li id='e' value='1'><span id="e"><b>Bay</b></span><br/></li><ul><li id='f'><span id="f">Bay City</span><br/></li></ul></ul></div>
<p id="g" class="line"><b>STREET CANVASSING CODE - MYU5PV</b><br>(Voter lookup and match only - no knock list)</p>
<p id="h" class="line"><b>DETROIT</b></p><div data-section-style='6'><ul id='i'><li id='j' value='1'><span id="j">DETROIT WARD 1 (NORTHWEST): <b>CH25Z9</b></span><br/></li><li id='k'><span id="k">DETROIT WARD 5A (CENTRAL, NEAR OFFICE): <b>K3PJRJ<br></b></span><br/></li></ul></div>
<p id="l" class="line"><b>WAYNE CITIES</b></p><div data-section-style='6'><ul id='m'><li id='n' value='1'><span id="n">ALLEN PARK &amp; LINCOLN PARK: <b>XV7SDY</b></span><br/></li></ul></div>
<p id="o" class="line"><b>OAKLAND COUNTY</b></p><div data-section-style='6'><ul id='p'><li id='q' value='1'><span id="q">FERNDALE - <b>QUJAUF</b></span><br/></li></ul></div>
<table><tr><td><p id="r" class="line"><b>CHAPTER</b></p></td><td><p id="s" class="line"><b>COUNTIES IN CHAPTER</b></p></td><td><p id="t" class="line"><b>CODE</b></p></td></tr>
<tr><td><p id="u" class="line">STREET CANVASS</p></td><td><p id="v" class="line">(VOTER LOOKUP ONLY)</p></td><td><p id="w" class="line">MYU5PV</p></td></tr>
<tr><td><p id="x">Allegan</p></td><td><p id="y">Allegan County</p></td><td><p id="z" class="line">4UNW8F</p></td></tr>
<tr><td><p id="aa"></p></td><td><p id="ab">Barry County</p></td><td><p id="ac" class="line">4UNW8F</p></td></tr>
<tr><td><p id="ad">Washtenaw</p></td><td><p id="ae">Washtenaw County</p></td><td><p id="af" class="line">ZT2H5D</p></td></tr></table></div>`;

describe('parseConversationCodes', () => {
	it('extracts table and metro-section codes with their chapters', () => {
		expect(parseConversationCodes(CANVAS_FIXTURE)).toEqual([
			{ code: '4UNW8F', chapter: 'Allegan' },
			{ code: 'CH25Z9', chapter: 'Detroit' },
			{ code: 'K3PJRJ', chapter: 'Detroit' },
			{ code: 'QUJAUF', chapter: 'Oakland' },
			{ code: 'XV7SDY', chapter: 'Wayne' },
			{ code: 'ZT2H5D', chapter: 'Washtenaw' },
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

	it('normalizes metro headers to chapter names (CITIES/COUNTY suffixes dropped)', () => {
		const byCode = new Map(parseConversationCodes(CANVAS_FIXTURE).map((c) => [c.code, c.chapter]));
		expect(byCode.get('XV7SDY')).toBe('Wayne');
		expect(byCode.get('QUJAUF')).toBe('Oakland');
		expect(byCode.get('CH25Z9')).toBe('Detroit');
	});

	it('accepts all-letter codes (real codes like QUJAUF have no digits)', () => {
		const byCode = new Map(parseConversationCodes(CANVAS_FIXTURE).map((c) => [c.code, c.chapter]));
		expect(byCode.get('QUJAUF')).toBe('Oakland');
	});

	it('ignores non-6-char tokens and returns [] for codeless HTML', () => {
		expect(
			parseConversationCodes('<p><b>HEADER</b></p><div><ul><li>WARD 12 - ABC1234</li></ul></div>'),
		).toEqual([]);
		expect(parseConversationCodes('')).toEqual([]);
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
						properties: {
							tabs: [
								{ type: 'canvas', data: { file_id: 'F_OTHER' } },
								{ type: 'files', data: {} },
								{ type: 'canvas', data: { file_id: 'F_CODES' } },
							],
						},
					},
				});
			}
			if (url.includes('files.info?file=F_OTHER') || url.includes('file=F_OTHER')) {
				return jsonRes({ ok: true, file: { title: 'Using Openfield', url_private: 'https://dl/other' } });
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

// Converts Solidarity's rich event-page HTML into the Markdown that Mobilize
// renders in event descriptions.
//
// Why this exists: Solidarity's /v1/events `description` is a FLATTENED plain
// text copy — the bold text, links and lists visible on the event page are
// stripped before we ever see them. The real content lives on the linked
// ActionPage (/v1/pages/{event_page_id}) as HTML.
//
// Why Markdown and not HTML: Mobilize renders descriptions as Markdown
// (help.mobilize.us "How to Use Markdown in Mobilize"), and none of the
// campaign's 25 hand-written Mobilize descriptions contain a single HTML tag —
// pasting raw HTML would show volunteers literal `<p style="...">` tags.
//
// Mobilize's formatting rules that shape the output:
//   - blocks must be separated by a blank line, or they collapse into one line
//   - a line break inside a paragraph needs two trailing spaces
//
// Deliberately a small hand-rolled parser rather than a dependency: the input is
// WYSIWYG-editor output (p / strong / em / a / ul / ol / li / br / h1-3, wrapped
// in styled span and div noise), not arbitrary web HTML.

const VOID_ELEMENTS = new Set([
	'br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'col', 'area',
]);

/** Dropped entirely, content and all. */
const DISCARDED = new Set(['script', 'style', 'iframe', 'form', 'input', 'nav', 'img']);

const BLOCK_ELEMENTS = new Set([
	'p', 'div', 'section', 'header', 'footer', 'main', 'article', 'figure',
	'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table',
	'thead', 'tbody', 'tfoot', 'tr', 'dl', 'dt', 'dd', 'blockquote', 'hr', 'pre',
]);

const NAMED_ENTITIES: Record<string, string> = {
	nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–',
	mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
	hellip: '…', bull: '•', middot: '·', times: '×', trade: '™', copy: '©',
	reg: '®', deg: '°', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä',
	ccedil: 'ç', laquo: '«', raquo: '»', euro: '€', pound: '£', frac12: '½',
	shy: '', zwnj: '', zwj: '', ensp: ' ', emsp: ' ', thinsp: ' ',
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
		if (body.startsWith('#')) {
			const code = body[1] === 'x' || body[1] === 'X'
				? parseInt(body.slice(2), 16)
				: parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
		}
		const named = NAMED_ENTITIES[body.toLowerCase()];
		return named === undefined ? match : named;
	});
}

interface ElementNode {
	type: 'element';
	name: string;
	attrs: Record<string, string>;
	children: Node[];
}
interface TextNode {
	type: 'text';
	value: string;
}
type Node = ElementNode | TextNode;

function parseAttrs(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const m of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
		// Attribute values are entity-encoded too — an href carrying
		// `?a=1&amp;b=2` must become `?a=1&b=2` or the link breaks.
		attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
	}
	return attrs;
}

/** Tolerant parse — WYSIWYG output has unclosed tags and stray closes. */
function parse(html: string): ElementNode {
	const root: ElementNode = { type: 'element', name: '#root', attrs: {}, children: [] };
	const stack: ElementNode[] = [root];
	const tagPattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
	let cursor = 0;

	const pushText = (value: string) => {
		if (value) stack[stack.length - 1].children.push({ type: 'text', value });
	};

	for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
		pushText(html.slice(cursor, match.index));
		cursor = match.index + match[0].length;
		if (match[0].startsWith('<!--')) continue;

		const name = match[1].toLowerCase();
		const isClose = match[0].startsWith('</');
		const selfClosing = match[2]?.trimEnd().endsWith('/');

		if (isClose) {
			// Close the nearest matching open tag; ignore a stray close.
			const index = stack.findLastIndex((node) => node.name === name);
			if (index > 0) stack.length = index;
			continue;
		}

		const node: ElementNode = { type: 'element', name, attrs: parseAttrs(match[2] ?? ''), children: [] };
		stack[stack.length - 1].children.push(node);
		if (!VOID_ELEMENTS.has(name) && !selfClosing) stack.push(node);
	}
	pushText(html.slice(cursor));
	return root;
}

/** Collapses runs of whitespace the way an HTML renderer would. */
function collapse(text: string): string {
	return text.replace(/[ \t\r\n\u00A0]+/g, ' ');
}

/**
 * Wrap inline content in markers, keeping any surrounding whitespace OUTSIDE
 * them. `<strong>8:00 pm </strong>for` must not become `**8:00 pm**for` —
 * markdown delimiters can't have inner padding, so the space has to move out.
 */
function wrapInline(inner: string, marker: string): string {
	const core = inner.trim();
	if (!core) return '';
	const lead = /^\s/.test(inner) ? ' ' : '';
	const trail = /\s$/.test(inner) ? ' ' : '';
	return `${lead}${marker}${core}${marker}${trail}`;
}

function renderInline(nodes: Node[]): string {
	let out = '';
	for (const node of nodes) {
		if (node.type === 'text') {
			out += collapse(decodeEntities(node.value));
			continue;
		}
		if (DISCARDED.has(node.name)) continue;

		switch (node.name) {
			case 'br':
				// Two trailing spaces = a hard line break inside a paragraph.
				out = `${out.trimEnd()}  \n`;
				break;
			case 'strong':
			case 'b':
				out += wrapInline(renderInline(node.children), '**');
				break;
			case 'em':
			case 'i':
				out += wrapInline(renderInline(node.children), '_');
				break;
			case 'a': {
				const raw = renderInline(node.children);
				const inner = raw.trim();
				const href = node.attrs.href ?? '';
				if (!inner) break;
				const lead = /^\s/.test(raw) ? ' ' : '';
				const trail = /\s$/.test(raw) ? ' ' : '';
				// A bare URL as its own label reads better unlinked.
				const body =
					href && href !== inner && !href.startsWith('#') ? `[${inner}](${href})` : inner;
				out += `${lead}${body}${trail}`;
				break;
			}
			default:
				out += renderInline(node.children);
		}
	}
	return out;
}

function renderListItems(list: ElementNode, depth: number, ordered: boolean): string[] {
	const lines: string[] = [];
	let index = 1;
	for (const child of list.children) {
		if (child.type !== 'element' || child.name !== 'li') continue;
		const nested = child.children.filter(
			(n): n is ElementNode => n.type === 'element' && (n.name === 'ul' || n.name === 'ol'),
		);
		const own = child.children.filter((n) => !nested.includes(n as ElementNode));
		const text = renderInline(own).trim().replace(/\s*\n\s*/g, ' ');
		const marker = ordered ? `${index}.` : '-';
		if (text) lines.push(`${'  '.repeat(depth)}${marker} ${text}`);
		index++;
		for (const sublist of nested) {
			lines.push(...renderListItems(sublist, depth + 1, sublist.name === 'ol'));
		}
	}
	return lines;
}

function renderBlocks(nodes: Node[]): string[] {
	const blocks: string[] = [];
	let inlineBuffer: Node[] = [];

	const flush = () => {
		if (inlineBuffer.length === 0) return;
		const text = renderInline(inlineBuffer).trim();
		if (text) blocks.push(text);
		inlineBuffer = [];
	};

	for (const node of nodes) {
		if (node.type === 'text' || !BLOCK_ELEMENTS.has(node.name)) {
			if (node.type === 'element' && DISCARDED.has(node.name)) continue;
			inlineBuffer.push(node);
			continue;
		}
		flush();

		switch (node.name) {
			case 'ul':
			case 'ol': {
				const lines = renderListItems(node, 0, node.name === 'ol');
				if (lines.length > 0) blocks.push(lines.join('\n'));
				break;
			}
			case 'h1':
			case 'h2':
			case 'h3':
			case 'h4':
			case 'h5':
			case 'h6': {
				const text = renderInline(node.children).trim();
				// Mobilize's smallest heading still renders large; ## keeps the
				// hierarchy without shouting.
				if (text) blocks.push(`${'#'.repeat(Math.min(Number(node.name[1]) + 1, 6))} ${text}`);
				break;
			}
			case 'tr': {
				const cells = node.children
					.filter((n): n is ElementNode => n.type === 'element' && (n.name === 'td' || n.name === 'th'))
					.map((cell) => renderInline(cell.children).trim())
					.filter(Boolean);
				if (cells.length > 0) blocks.push(cells.join(' | '));
				break;
			}
			case 'hr':
				break;
			default:
				blocks.push(...renderBlocks(node.children));
		}
	}
	flush();
	return blocks;
}

/**
 * Convert event-page HTML to Mobilize-flavored Markdown. Blocks are separated
 * by a blank line, which is what stops Mobilize collapsing them onto one line.
 */
export function htmlToMarkdown(html: string): string {
	if (!html) return '';
	const blocks = renderBlocks(parse(html).children)
		.map((block) =>
			block
				.split('\n')
				// Trailing whitespace is noise EXCEPT the two spaces that encode a
				// hard line break — stripping those re-collapses the line in Mobilize.
				.map((line) => line.replace(/[ \t]+$/, (run) => (run.length >= 2 ? '  ' : '')))
				.join('\n')
				.trim(),
		)
		.filter(Boolean);
	return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Fallback for events with no rich page: Solidarity's flattened description
 * separates paragraphs with a single "\n", which Mobilize would collapse into
 * one run-on block. Promote those to blank-line-separated paragraphs.
 */
export function plainTextToMarkdown(text: string): string {
	if (!text) return '';
	// The flattened text still carries HTML entities ("Abdul &amp; friends").
	return decodeEntities(text)
		.replace(/\r\n?/g, '\n')
		.split(/\n+/)
		.map((line) => line.trim())
		.filter(Boolean)
		.join('\n\n');
}

import { describe, expect, it } from 'vitest';

import { decodeEntities, htmlToMarkdown, plainTextToMarkdown } from './html-to-markdown.js';

describe('decodeEntities', () => {
	it('decodes named, decimal and hex entities', () => {
		expect(decodeEntities('a&nbsp;b &amp; c &#39;d&#39; &#x2019;')).toBe("a b & c 'd' ’");
	});

	it('leaves unknown entities alone', () => {
		expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
	});
});

describe('htmlToMarkdown', () => {
	it('separates paragraphs with a blank line so Mobilize does not collapse them', () => {
		expect(htmlToMarkdown('<p>One</p>\n<p>Two</p>')).toBe('One\n\nTwo');
	});

	it('converts bold and italic', () => {
		expect(htmlToMarkdown('<p><strong>Bold</strong> and <em>italic</em></p>')).toBe(
			'**Bold** and _italic_',
		);
		expect(htmlToMarkdown('<p><b>B</b> <i>I</i></p>')).toBe('**B** _I_');
	});

	it('keeps whitespace outside the emphasis markers', () => {
		// `**8:00 pm**for` — markdown delimiters cannot have inner padding, so a
		// trailing space inside <strong> has to move out or the words run together.
		expect(htmlToMarkdown('<p>at <strong>8:00 pm </strong>for the rally</p>')).toBe(
			'at **8:00 pm** for the rally',
		);
		expect(htmlToMarkdown('<p>a<em> b </em>c</p>')).toBe('a _b_ c');
	});

	it('converts links', () => {
		expect(htmlToMarkdown('<p>See <a href="https://x.com/y">the form</a>.</p>')).toBe(
			'See [the form](https://x.com/y).',
		);
	});

	it('decodes entities inside the href so query strings are not broken', () => {
		expect(
			htmlToMarkdown('<p><a href="https://x.com/e?ref=7905864&amp;name=Cassidy">RSVP</a></p>'),
		).toBe('[RSVP](https://x.com/e?ref=7905864&name=Cassidy)');
	});

	it('does not linkify a bare url that is its own label', () => {
		expect(htmlToMarkdown('<p><a href="https://x.com">https://x.com</a></p>')).toBe(
			'https://x.com',
		);
	});

	it('strips the styling noise a WYSIWYG editor leaves behind', () => {
		const html =
			'<p style="box-sizing: border-box; margin: 0px 0px 10.5px; color: #001f3f;">' +
			'<strong style="font-weight: bold;">Join us!</strong></p>';
		expect(htmlToMarkdown(html)).toBe('**Join us!**');
	});

	it('renders a bulleted list as its own block', () => {
		expect(htmlToMarkdown('<p>Bring:</p><ul><li>Water</li><li>Shoes</li></ul>')).toBe(
			'Bring:\n\n- Water\n- Shoes',
		);
	});

	it('indents nested lists', () => {
		const html = '<ul><li>Outer<ul><li>Inner</li></ul></li></ul>';
		expect(htmlToMarkdown(html)).toBe('- Outer\n  - Inner');
	});

	it('numbers ordered lists', () => {
		expect(htmlToMarkdown('<ol><li>First</li><li>Second</li></ol>')).toBe('1. First\n2. Second');
	});

	it('turns headings into markdown headings one level down', () => {
		expect(htmlToMarkdown('<h2>Details</h2><p>Body</p>')).toBe('### Details\n\nBody');
	});

	it('renders <br> as a hard line break with two trailing spaces', () => {
		expect(htmlToMarkdown('<p>Line one<br />Line two</p>')).toBe('Line one  \nLine two');
	});

	it('drops scripts, styles and images', () => {
		expect(
			htmlToMarkdown('<p>Keep</p><script>evil()</script><style>a{}</style><img src="x.png">'),
		).toBe('Keep');
	});

	it('survives unclosed and stray tags', () => {
		expect(htmlToMarkdown('<p>One<p>Two</div></p>')).toBe('One\n\nTwo');
	});

	it('collapses whitespace and decodes entities inside text', () => {
		expect(htmlToMarkdown('<p>Hello\n   there&nbsp;&amp; welcome</p>')).toBe(
			'Hello there & welcome',
		);
	});

	it('handles the real Warren event page markup', () => {
		const html =
			'<p style="margin: 0px 0px 10.5px; color: #001f3f;"><strong style="font-weight: bold;">' +
			'Join Dr. Abdul El-Sayed and special guest Rep Analilia Mejia for a Rally and Canvass Launch in Warren!' +
			'</strong></p>\n<p style="margin: 0px;">This is it: the final stretch.</p>';
		expect(htmlToMarkdown(html)).toBe(
			'**Join Dr. Abdul El-Sayed and special guest Rep Analilia Mejia for a Rally and Canvass Launch in Warren!**\n\n' +
				'This is it: the final stretch.',
		);
	});

	it('returns empty for empty input', () => {
		expect(htmlToMarkdown('')).toBe('');
		expect(htmlToMarkdown('<p></p><div>  </div>')).toBe('');
	});
});

describe('plainTextToMarkdown', () => {
	it('promotes single newlines to blank-line paragraph breaks', () => {
		// Solidarity's flattened descriptions use single \n between paragraphs,
		// which Mobilize renders as one run-on block.
		expect(plainTextToMarkdown('Para one.\nPara two.\nPara three.')).toBe(
			'Para one.\n\nPara two.\n\nPara three.',
		);
	});

	it('decodes entities left in the flattened text', () => {
		expect(plainTextToMarkdown('Abdul &amp; Special Guests')).toBe('Abdul & Special Guests');
	});

	it('does not double up existing blank lines', () => {
		expect(plainTextToMarkdown('One.\n\nTwo.')).toBe('One.\n\nTwo.');
	});

	it('returns empty for empty input', () => {
		expect(plainTextToMarkdown('')).toBe('');
	});
});

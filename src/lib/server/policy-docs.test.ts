import { describe, it, expect } from 'vitest';
import {
	slugify,
	rewriteHref,
	renderPolicy,
	PRIVACY_DOC,
	SECURITY_DOC,
	POLICY_DOCS,
} from './policy-docs.js';

describe('slugify', () => {
	it('matches the anchors GitHub generates, which the documents link to', () => {
		expect(slugify('How long it is kept')).toBe('how-long-it-is-kept');
		expect(slugify('Your choices')).toBe('your-choices');
		expect(slugify('For other operators')).toBe('for-other-operators');
	});

	it('drops punctuation rather than encoding it', () => {
		expect(slugify('What is collected, and why')).toBe('what-is-collected-and-why');
		expect(slugify('Reporting a vulnerability')).toBe('reporting-a-vulnerability');
	});
});

describe('rewriteHref', () => {
	it('turns the cross-document links into in-page anchors', () => {
		expect(rewriteHref('SECURITY.md', 'privacy')).toBe('#security');
		expect(rewriteHref('PRIVACY.md', 'security')).toBe('#privacy');
	});

	it('namespaces a link to the document own sections', () => {
		expect(rewriteHref('#your-choices', 'privacy')).toBe('#privacy-your-choices');
		expect(rewriteHref('#scope', 'security')).toBe('#security-scope');
	});

	it('leaves external links alone', () => {
		expect(rewriteHref('https://github.com/tools4abdul/x', 'privacy')).toBe(
			'https://github.com/tools4abdul/x',
		);
	});
});

describe('the rendered documents', () => {
	it('renders both, titled from their H1', () => {
		expect(POLICY_DOCS.map((d) => d.slug)).toEqual(['privacy', 'security']);
		expect(PRIVACY_DOC.title).toBe('Privacy Policy');
		expect(SECURITY_DOC.title).toBe('Security Policy');
	});

	// The page already has an <h1> in the header. A second one flattens the
	// heading order a screen reader navigates by.
	it('demotes the document H1 to the section anchor and emits no <h1>', () => {
		for (const doc of POLICY_DOCS) {
			expect(doc.html).not.toMatch(/<h1[\s>]/);
			expect(doc.html).toContain(`<h2 id="${doc.slug}">`);
		}
	});

	it('namespaces heading ids so the two documents cannot collide', () => {
		expect(PRIVACY_DOC.html).toContain('id="privacy-how-long-it-is-kept"');
		expect(SECURITY_DOC.html).toContain('id="security-reporting-a-vulnerability"');
		for (const doc of POLICY_DOCS) {
			for (const heading of doc.headings) {
				expect(heading.id.startsWith(`${doc.slug}-`), heading.id).toBe(true);
			}
		}
	});

	// A contents list built from headings nobody can jump to is furniture.
	it('lists sections whose ids exist in the rendered HTML', () => {
		for (const doc of POLICY_DOCS) {
			expect(doc.headings.length).toBeGreaterThan(3);
			for (const heading of doc.headings) {
				expect(doc.html, heading.id).toContain(`id="${heading.id}"`);
			}
		}
	});

	it('rewrites every in-document link to an anchor that exists on the page', () => {
		const ids = new Set(
			POLICY_DOCS.flatMap((doc) => [
				doc.slug,
				...[...doc.html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!),
			]),
		);
		for (const doc of POLICY_DOCS) {
			const anchors = [...doc.html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
			expect(anchors.length).toBeGreaterThan(0);
			for (const anchor of anchors) {
				expect(ids.has(anchor), `${doc.slug} links to #${anchor}`).toBe(true);
			}
		}
	});

	it('leaves no bare .md link to 404 on the web', () => {
		for (const doc of POLICY_DOCS) {
			expect(doc.html).not.toMatch(/href="[^"]*\.md"/);
		}
	});

	it('marks off-site links noopener, since this page is public', () => {
		expect(PRIVACY_DOC.html + SECURITY_DOC.html).toContain('rel="noopener noreferrer"');
	});

	// Overriding marked's `link` renderer means losing the attribute escaping the
	// stock one does, and the result goes through `{@html}` on the one page
	// served to the public. Asserted on `render` directly rather than on the two
	// committed documents, which do not currently contain a quote to escape —
	// the guarantee has to survive the next edit to them.
	it('escapes quotes in a link href and title rather than breaking the attribute', () => {
		const { html } = renderPolicy(
			'# T\n\n[x](<a"onmouseover=alert(1)>) [z](/p (ti"tle))\n',
			'privacy',
		);
		expect(html).not.toMatch(/href="[^"]*"[^>]*onmouseover/);
		expect(html).toContain('&quot;onmouseover');
		expect(html).toContain('title="ti&quot;tle"');
	});

	// Cheap canaries: if the policy text is edited into something that no longer
	// says these things, the tests should be read, not silently deleted.
	it('carries the commitments the documents are there to make', () => {
		expect(PRIVACY_DOC.html).toContain('3 November 2026');
		expect(SECURITY_DOC.html).toContain('Report a vulnerability');
	});
});

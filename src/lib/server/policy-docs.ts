// The privacy and security policies, rendered for the web.
//
// PRIVACY.md and SECURITY.md in the repository root are the source of truth —
// they are what a reader gets on GitHub and what a reviewer diffs. This module
// renders those same files for /policies rather than keeping a second copy in a
// Svelte component, because two copies of a policy is how a site ends up
// promising something the repository does not.
//
// The files are pulled in with Vite's `?raw`, so their text is inlined into the
// server bundle at build time. That matters for deployment: the Docker image
// ships the build output, not the markdown, and a runtime `readFile` would work
// in dev and 500 in production.
//
// Both documents render onto ONE page, which creates two problems this module
// exists to solve:
//
//   * Heading ids would collide (both files have a "For operators"-shaped
//     section), so every id is namespaced with its document's slug.
//   * The documents link to each other and to their own sections — `[SECURITY
//     .md](SECURITY.md)`, `(#your-choices)`. On GitHub those resolve; on one
//     page they have to become in-page anchors, rewritten with the same
//     namespace as the ids.

import { Marked, type Tokens } from 'marked';
import privacyMarkdown from '../../../PRIVACY.md?raw';
import securityMarkdown from '../../../SECURITY.md?raw';

export type PolicyHeading = { id: string; text: string };

export type PolicyDoc = {
	/** Namespace for this document's heading ids: `privacy` / `security`. */
	slug: string;
	/** The document's H1, used as the section heading. */
	title: string;
	/** Rendered HTML, headings demoted one level and ids namespaced. */
	html: string;
	/** The document's top-level sections, for the page's contents list. */
	headings: PolicyHeading[];
};

/**
 * GitHub's heading-anchor rules, near enough for these two files: lowercase,
 * drop anything that is not a word character or a space, spaces to hyphens.
 *
 * It has to match GitHub's because the markdown contains hand-written links to
 * its own sections (`#how-long-it-is-kept`) which were written against it.
 */
export function slugify(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-');
}

/**
 * Escape a string for use inside a double-quoted HTML attribute.
 *
 * Overriding marked's `link` renderer means losing the escaping the default one
 * does — verified against marked 18: the stock renderer emits
 * `href="a%22onmouseover=..."` where a raw interpolation emits
 * `href="a"onmouseover=..."`, which is an attribute breakout. Nothing in
 * PRIVACY.md or SECURITY.md exercises that today, and both are committed to
 * this repository rather than typed by anyone. But this is the one page served
 * to the public, and the `{@html}` in +page.svelte is safe only because
 * everything reaching it is escaped — so the renderer that replaces marked's
 * has to do the escaping marked's did.
 */
function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/** Where a link inside one of these documents should point on /policies. */
export function rewriteHref(href: string, slug: string): string {
	if (href === 'PRIVACY.md') return '#privacy';
	if (href === 'SECURITY.md') return '#security';
	// A link to the document's own section: namespace it the way the ids are.
	if (href.startsWith('#')) return `#${slug}-${href.slice(1)}`;
	return href;
}

/** Render one document. Exported for tests: the escaping in the renderers
 *  below is a security property of the public page, and asserting it on the two
 *  committed files only would leave it untested until one of them happened to
 *  contain a quote. */
export function renderPolicy(markdown: string, slug: string): PolicyDoc {
	const headings: PolicyHeading[] = [];
	let title = '';

	// A fresh instance per document: `marked.use()` mutates global state, and
	// two documents rendering through one configured instance would share the
	// heading collector.
	const instance = new Marked({
		renderer: {
			heading(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, token) {
				const text = token.text.trim();
				// The page already has an <h1> in its header, so the document's
				// own H1 becomes the section's <h2> and everything shifts down
				// with it. Heading order is how a screen reader navigates a
				// document this long; two <h1>s would flatten it.
				const level = Math.min(token.depth + 1, 6);
				if (token.depth === 1) {
					title = text;
					// The section anchor is the bare slug (`#privacy`), which is
					// what the cross-document links above are rewritten to.
					return `<h2 id="${slug}">${this.parser.parseInline(token.tokens ?? [])}</h2>\n`;
				}
				const id = `${slug}-${slugify(text)}`;
				if (token.depth === 2) headings.push({ id, text });
				return `<h${level} id="${id}">${this.parser.parseInline(token.tokens ?? [])}</h${level}>\n`;
			},
			link(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, token) {
				const href = rewriteHref(token.href, slug);
				// `inner` is already escaped — it comes back from marked's own
				// inline parser. `href` and `title` are raw token text and are
				// not; see escapeAttribute.
				const inner = this.parser.parseInline(token.tokens ?? []);
				const titleAttr = token.title ? ` title="${escapeAttribute(token.title)}"` : '';
				// Off-site links leak the referrer otherwise, and this page is
				// public — the one page a stranger reads before trusting us.
				// Tested against the rewritten href, so `PRIVACY.md` and `#anchor`
				// stay same-tab.
				const external = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
				return `<a href="${escapeAttribute(href)}"${titleAttr}${external}>${inner}</a>`;
			},
		},
	});

	const html = instance.parse(markdown, { async: false });
	return { slug, title, html, headings };
}

// Parsed once at module load rather than per request. The input is a build-time
// constant, so a second parse could never produce a different answer.
export const PRIVACY_DOC: PolicyDoc = renderPolicy(privacyMarkdown, 'privacy');
export const SECURITY_DOC: PolicyDoc = renderPolicy(securityMarkdown, 'security');

export const POLICY_DOCS: PolicyDoc[] = [PRIVACY_DOC, SECURITY_DOC];

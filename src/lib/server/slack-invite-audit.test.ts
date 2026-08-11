import { describe, it, expect } from 'vitest';
import {
	collectInviteRefs,
	collectInviteRefsFromHtml,
	needsRenderedHtml,
	classifyInvite,
	formatAuditMessage,
	auditIsWorthPosting,
	type SolidarityPage,
	type AuditResult,
} from './slack-invite-audit.js';

const FRESH =
	'https://join.slack.com/t/exampleworkspace/shared_invite/zt-46jrhrg1c-kFKiceBUumatfgujdSzFmQ';
const STALE =
	'https://join.slack.com/t/exampleworkspace/shared_invite/zt-3uwkykldf-20xkOyZVYH1VKkVDnWDVLw';

function page(overrides: Partial<SolidarityPage> = {}): SolidarityPage {
	return {
		id: 1,
		type: 'ActionPage::GenericForm',
		name: 'Test Page',
		url_slug: 'test',
		full_url: 'https://go.example.org/test',
		is_published: true,
		...overrides,
	};
}

function response(init: { status: number; body?: string; location?: string }): Response {
	const headers = new Headers();
	if (init.location) headers.set('location', init.location);
	return new Response(init.body ?? '', { status: init.status, headers });
}

describe('needsRenderedHtml', () => {
	// The whole reason this audit exists: these two types return a stub from the
	// API, so an API-only scan silently reports zero links for them.
	it('flags the page types whose body the API omits', () => {
		expect(needsRenderedHtml(page({ type: 'ActionPage::PageBuilder' }))).toBe(true);
		expect(needsRenderedHtml(page({ type: 'ActionPage::BlogPost' }))).toBe(true);
	});

	it('leaves types whose body the API returns to the cheap API scan', () => {
		expect(needsRenderedHtml(page({ type: 'ActionPage::Event' }))).toBe(false);
		expect(needsRenderedHtml(page({ type: 'ActionPage::GenericForm' }))).toBe(false);
	});
});

describe('collectInviteRefs', () => {
	it('finds a link in each of the four places a volunteer can receive one', () => {
		const refs = collectInviteRefs(
			page({
				description: `<a href="${FRESH}">join</a>`,
				follow_up: { type: 'redirect', url: FRESH },
				confirmations: {
					email: { content: { en: `<a href="${FRESH}">join</a>` } },
					text: { content: { en: `click here: ${FRESH}` } },
				},
			}),
		);
		expect(refs.map((r) => r.location).sort()).toEqual([
			'follow-up email',
			'follow-up text',
			'page content',
			'redirect URL',
		]);
	});

	it('reports one page carrying two different invites as two refs', () => {
		// Page 6668 really is like this: its redirect and its confirmations point
		// at different invite tokens, so reporting only the first would hide one.
		const refs = collectInviteRefs(
			page({ follow_up: { url: STALE }, confirmations: { text: { content: { en: FRESH } } } }),
		);
		expect(refs).toHaveLength(2);
		expect(new Set(refs.map((r) => r.url))).toEqual(new Set([FRESH, STALE]));
	});

	it('returns nothing for a page with no invite links', () => {
		expect(collectInviteRefs(page({ description: '<p>No links here</p>' }))).toEqual([]);
	});

	it('does not let an adjacent HTML attribute bleed into the captured URL', () => {
		const refs = collectInviteRefs(
			page({ description: `<a href="${FRESH}" target="_blank">x</a>` }),
		);
		expect(refs[0].url).toBe(FRESH);
	});
});

describe('collectInviteRefsFromHtml', () => {
	it('attributes a link found in rendered HTML to the page body', () => {
		const refs = collectInviteRefsFromHtml(
			page({ type: 'ActionPage::PageBuilder' }),
			`<div><a class="btn" href="${FRESH}">Join our Slack</a></div>`,
		);
		expect(refs).toEqual([
			expect.objectContaining({ url: FRESH, location: 'page content', pageId: 1 }),
		]);
	});

	it('collapses the same link repeated across the page', () => {
		const refs = collectInviteRefsFromHtml(
			page({ type: 'ActionPage::PageBuilder' }),
			`<a href="${FRESH}">top</a><a href="${FRESH}">bottom</a>`,
		);
		expect(refs).toHaveLength(1);
	});
});

describe('classifyInvite', () => {
	it('follows the join.slack.com rewrite, which is blind to the token', async () => {
		const seen: string[] = [];
		const fake = (async (url: string) => {
			seen.push(url);
			return seen.length === 1
				? response({
						status: 302,
						location: 'https://exampleworkspace.slack.com/join/shared_invite/zt-46jrhrg1c-x',
					})
				: response({ status: 200, body: '<title>Join … on Slack</title>' });
		}) as unknown as typeof fetch;

		expect(await classifyInvite(FRESH, fake)).toMatchObject({ status: 'valid' });
		expect(seen).toHaveLength(2);
	});

	it('treats the domain-restricted signup redirect as broken', async () => {
		const fake = (async () =>
			response({
				status: 302,
				location: 'https://exampleworkspace.slack.com/signup#/domain-signup',
			})) as unknown as typeof fetch;

		const result = await classifyInvite(
			'https://exampleworkspace.slack.com/join/shared_invite/zt-3uwkykldf-x',
			fake,
		);
		expect(result.status).toBe('broken');
		expect(result.detail).toMatch(/domain-restricted/);
	});

	it('treats an unrecognised token as broken', async () => {
		const fake = (async () =>
			response({
				status: 200,
				body: '<title>Create Account | Slack</title>',
			})) as unknown as typeof fetch;
		expect(await classifyInvite(FRESH, fake)).toMatchObject({ status: 'broken' });
	});

	// The failure mode that would destroy trust in this alert: Slack raises its
	// minimum browser version, every link starts looking dead, and the channel
	// fills with false alarms. It must degrade to 'unknown' instead.
	it('reports an aged-out User-Agent as unknown, never as broken', async () => {
		const fake = (async () =>
			response({
				status: 403,
				body: "We're very sorry, but your browser is not supported!",
			})) as unknown as typeof fetch;

		const result = await classifyInvite(FRESH, fake);
		expect(result.status).toBe('unknown');
		expect(result.detail).toMatch(/BROWSER_UA/);
	});

	it('reports a network failure as unknown rather than broken', async () => {
		const fake = (async () => {
			throw new Error('ECONNRESET');
		}) as unknown as typeof fetch;
		expect(await classifyInvite(FRESH, fake)).toMatchObject({ status: 'unknown' });
	});
});

describe('formatAuditMessage', () => {
	function result(overrides: Partial<AuditResult> = {}): AuditResult {
		return {
			pagesScanned: 1442,
			pagesFetchedAsHtml: 73,
			refs: [],
			distinctUrls: 0,
			statuses: new Map(),
			broken: [],
			unknown: [],
			...overrides,
		};
	}

	it('groups two broken locations on one page into a single entry', () => {
		const refs = [
			{
				url: STALE,
				pageId: 10904,
				pageName: 'Women’s Caucus',
				pageUrl: '',
				location: 'follow-up email' as const,
			},
			{
				url: STALE,
				pageId: 10904,
				pageName: 'Women’s Caucus',
				pageUrl: '',
				location: 'follow-up text' as const,
			},
		];
		const msg = formatAuditMessage(
			result({
				refs,
				broken: refs,
				distinctUrls: 1,
				statuses: new Map([
					[
						STALE,
						{ status: 'broken' as const, detail: 'redirects to the domain-restricted signup form' },
					],
				]),
			}),
		);
		expect(msg).toMatch(/1 page\(s\) have a broken invite link/);
		expect(msg).toMatch(/follow-up email, follow-up text/);
		expect(msg).toContain('dashboard.solidarity.tech/pages/10904');
	});

	it('says so plainly when everything works', () => {
		const msg = formatAuditMessage(
			result({
				refs: [{ url: FRESH, pageId: 1, pageName: 'p', pageUrl: '', location: 'page content' }],
				distinctUrls: 1,
				statuses: new Map([[FRESH, { status: 'valid', detail: 'ok' }]]),
			}),
		);
		expect(msg).toMatch(/all clear/);
	});

	it('keeps unchecked links visually separate from broken ones', () => {
		const ref = {
			url: FRESH,
			pageId: 1,
			pageName: 'p',
			pageUrl: '',
			location: 'page content' as const,
		};
		const msg = formatAuditMessage(
			result({
				refs: [ref],
				unknown: [ref],
				distinctUrls: 1,
				statuses: new Map([[FRESH, { status: 'unknown', detail: 'fetch failed: ECONNRESET' }]]),
			}),
		);
		expect(msg).toMatch(/could not be checked/);
		expect(msg).not.toMatch(/rotating_light/);
	});
});

describe('auditIsWorthPosting', () => {
	const ref = {
		url: FRESH,
		pageId: 1,
		pageName: 'p',
		pageUrl: '',
		location: 'page content' as const,
	};

	function result(overrides: Partial<AuditResult> = {}): AuditResult {
		return {
			pagesScanned: 1442,
			pagesFetchedAsHtml: 73,
			refs: [ref],
			distinctUrls: 1,
			statuses: new Map([[FRESH, { status: 'valid' as const, detail: 'ok' }]]),
			broken: [],
			unknown: [],
			...overrides,
		};
	}

	it('stays quiet when every link works and nothing changed', () => {
		expect(auditIsWorthPosting(result(), 0)).toBe(false);
	});

	it('speaks up for a link that came back from the dead', () => {
		// An all-clear run, but a fix since the last check is news worth having.
		expect(auditIsWorthPosting(result(), 1)).toBe(true);
	});

	it('speaks up for broken and for unchecked links alike', () => {
		expect(auditIsWorthPosting(result({ broken: [ref] }), 0)).toBe(true);
		expect(auditIsWorthPosting(result({ unknown: [ref] }), 0)).toBe(true);
	});
});

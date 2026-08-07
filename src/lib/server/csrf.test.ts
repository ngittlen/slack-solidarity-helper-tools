import { describe, it, expect } from 'vitest';
import { isCrossSiteFormPost } from './csrf.js';

const ORIGIN = 'https://app.example.com';

function req(
	opts: {
		method?: string;
		contentType?: string | null;
		origin?: string | null;
	} = {},
): Request {
	const headers = new Headers();
	if (opts.contentType !== null && opts.contentType !== undefined) {
		headers.set('content-type', opts.contentType);
	}
	if (opts.origin) headers.set('origin', opts.origin);
	return new Request(`${ORIGIN}/whatever`, { method: opts.method ?? 'POST', headers });
}

const url = (path: string) => new URL(path, ORIGIN);

describe('isCrossSiteFormPost', () => {
	it('blocks a form POST with no Origin header — the Slack-shaped request', () => {
		expect(
			isCrossSiteFormPost(
				req({ contentType: 'application/x-www-form-urlencoded' }),
				url('/some/route'),
			),
		).toBe(true);
	});

	it('exempts /api/slack/* — those verify a Slack HMAC signature instead', () => {
		for (const path of ['/api/slack/commands', '/api/slack/interactivity', '/api/slack/events']) {
			expect(
				isCrossSiteFormPost(req({ contentType: 'application/x-www-form-urlencoded' }), url(path)),
			).toBe(false);
		}
	});

	it('does not exempt a path that merely starts with the same characters', () => {
		expect(
			isCrossSiteFormPost(
				req({ contentType: 'application/x-www-form-urlencoded' }),
				url('/api/slackish/evil'),
			),
		).toBe(true);
	});

	it('allows a same-origin form POST (the /auth/logout case)', () => {
		expect(
			isCrossSiteFormPost(
				req({ contentType: 'application/x-www-form-urlencoded', origin: ORIGIN }),
				url('/auth/logout'),
			),
		).toBe(false);
	});

	it('blocks a form POST from a different origin', () => {
		expect(
			isCrossSiteFormPost(
				req({ contentType: 'application/x-www-form-urlencoded', origin: 'https://evil.test' }),
				url('/auth/logout'),
			),
		).toBe(true);
	});

	it('allows JSON POSTs regardless of origin — not a form content type', () => {
		expect(isCrossSiteFormPost(req({ contentType: 'application/json' }), url('/api/helped'))).toBe(
			false,
		);
	});

	it('allows GET even with a form content type', () => {
		expect(
			isCrossSiteFormPost(
				req({ method: 'GET', contentType: 'application/x-www-form-urlencoded' }),
				url('/some/route'),
			),
		).toBe(false);
	});

	it.each(['PUT', 'PATCH', 'DELETE'])('protects %s as well as POST', (method) => {
		expect(
			isCrossSiteFormPost(
				req({ method, contentType: 'application/x-www-form-urlencoded' }),
				url('/some/route'),
			),
		).toBe(true);
	});

	it.each(['multipart/form-data', 'text/plain'])('treats %s as a form content type', (type) => {
		expect(isCrossSiteFormPost(req({ contentType: type }), url('/some/route'))).toBe(true);
	});

	it('ignores content-type parameters and casing', () => {
		expect(
			isCrossSiteFormPost(
				req({ contentType: 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' }),
				url('/some/route'),
			),
		).toBe(true);
	});

	it('allows a request with no content-type at all', () => {
		expect(isCrossSiteFormPost(req({ contentType: null }), url('/some/route'))).toBe(false);
	});
});

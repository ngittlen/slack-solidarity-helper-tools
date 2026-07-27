// We don't have access to the Mobilize API, so the migrator drives the same private
// endpoint the dashboard uses. That means borrowing a logged-in browser
// session: a `sessionid` cookie plus the matching `csrftoken`. Both are
// short-lived — when a run starts failing with 403, grab fresh values.
//
// How to refresh:
//   1. Log in to https://www.mobilize.us/dashboard/<org>/ in a browser.
//   2. DevTools → Network → any request → copy the `Cookie` header and the
//      `X-CSRFToken` header.
//   3. Put them in .env.local as MOBILIZE_COOKIE / MOBILIZE_CSRF_TOKEN.
//
// Values are read at runtime and never logged.

import { env } from './env.js';

export interface MobilizeSession {
	orgSlug: string;
	cookie: string;
	csrfToken: string;
	userAgent: string;
}

const DEFAULT_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0';

export function loadSession(): MobilizeSession {
	const cookie = env('MOBILIZE_COOKIE');
	if (!cookie) {
		throw new Error(
			'Missing MOBILIZE_COOKIE — copy the Cookie header from a logged-in mobilize.us dashboard request into .env.local',
		);
	}
	// The CSRF token is also carried in the cookie itself; derive it so only one
	// value has to be pasted.
	const csrfToken =
		env('MOBILIZE_CSRF_TOKEN') || /(?:^|;\s*)csrftoken=([^;]+)/.exec(cookie)?.[1] || '';
	if (!csrfToken) {
		throw new Error('Missing MOBILIZE_CSRF_TOKEN and no csrftoken= found in MOBILIZE_COOKIE');
	}
	if (!/(?:^|;\s*)sessionid=/.test(cookie)) {
		throw new Error('MOBILIZE_COOKIE has no sessionid= — that session will not be authenticated');
	}
	return {
		orgSlug: env('MOBILIZE_ORG_SLUG') || 'abdulforsenate',
		cookie,
		csrfToken,
		userAgent: env('MOBILIZE_USER_AGENT') || DEFAULT_UA,
	};
}

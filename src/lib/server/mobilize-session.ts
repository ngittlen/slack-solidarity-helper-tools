// Shared credentials for both Mobilize syncs (events out, attendees back).
//
// Mobilize has no public write API and issues no machine credentials, so
// MOBILIZE_COOKIE is a borrowed browser session. It expires — Django's default
// is two weeks — and cannot be renewed programmatically, because Mobilize logs
// in by emailed code or Google OAuth with no password endpoint. Both syncs
// report `sessionExpired` on a 403 and post a Slack alert asking for a fresh
// value.
//
// Only `sessionid` and `csrftoken` are required; the Cloudflare `__cf_bm` cookie
// present in a captured header is not, which is what makes storing this as a
// long-lived secret viable at all.

import type { MobilizeSession } from '../../../mobilize-migrator/lib/session.js';
import { MOBILIZE_COOKIE, MOBILIZE_CSRF_TOKEN, MOBILIZE_ORG_SLUG } from './env.js';

export function loadMobilizeSession(purpose: string): MobilizeSession {
	if (!MOBILIZE_COOKIE) {
		throw new Error(`MOBILIZE_COOKIE is not set — ${purpose} cannot authenticate`);
	}
	const csrfToken =
		MOBILIZE_CSRF_TOKEN || /(?:^|;\s*)csrftoken=([^;]+)/.exec(MOBILIZE_COOKIE)?.[1] || '';
	if (!csrfToken) {
		throw new Error(
			'No CSRF token — set MOBILIZE_CSRF_TOKEN or include csrftoken= in MOBILIZE_COOKIE',
		);
	}
	// Checked for both syncs: without it every request comes back 403 and looks
	// like an expired session rather than a malformed secret.
	if (!/(?:^|;\s*)sessionid=/.test(MOBILIZE_COOKIE)) {
		throw new Error('MOBILIZE_COOKIE has no sessionid= — that session is not authenticated');
	}
	return {
		orgSlug: MOBILIZE_ORG_SLUG,
		cookie: MOBILIZE_COOKIE,
		csrfToken,
		userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) slack-solidarity-helper-tools',
	};
}

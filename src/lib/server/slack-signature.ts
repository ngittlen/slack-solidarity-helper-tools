// Slack request signature verification, shared by every inbound Slack route
// (/api/slack/events, /api/slack/commands, /api/slack/interactivity).
//
// Lives here rather than in the events route because that module builds the
// canvas watcher and an Openfield client at import time — importing it from the
// command routes just to reuse one function would drag all of that along.
//
// The HMAC is computed over the raw request body, so it works identically for
// the events route's JSON payloads and the command/interactivity routes'
// form-encoded ones. Only the parsing afterwards differs.
//
// This is also what justifies exempting /api/slack/* from the CSRF origin check
// in src/lib/server/csrf.ts: a forged cross-site POST cannot produce a valid
// signature.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { SLACK_SIGNING_SECRET } from './env.js';

/** Reject anything older than this to blunt replay attacks. */
const MAX_SKEW_SECONDS = 300;

export async function verifySlackSignature(request: Request, body: string): Promise<boolean> {
	if (!SLACK_SIGNING_SECRET) {
		console.error('[slack-signature] SLACK_SIGNING_SECRET is not set');
		return false;
	}
	const signature = request.headers.get('x-slack-signature');
	const timestamp = request.headers.get('x-slack-request-timestamp');
	if (!signature || !timestamp) return false;

	if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > MAX_SKEW_SECONDS) return false;

	const sigBasestring = `v0:${timestamp}:${body}`;
	const computed = `v0=${createHmac('sha256', SLACK_SIGNING_SECRET).update(sigBasestring).digest('hex')}`;

	// timingSafeEqual throws on a length mismatch, so the pre-check is required,
	// not merely an optimization.
	if (computed.length !== signature.length) return false;
	return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

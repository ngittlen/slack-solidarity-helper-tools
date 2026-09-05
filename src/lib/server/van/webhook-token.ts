// Per-turf capability tokens for VAN's export-job webhook.
//
// VAN REQUIRES `webhookUrl` on POST /exportJobs and stores it against the job,
// echoes it back on every read of that job, and posts to it from their
// infrastructure. Whatever is in that URL is therefore held by a third party
// indefinitely and appears in their request logs.
//
// So it must not be `INTERNAL_CRON_SECRET`. That one secret gates seven
// internal endpoints — the catalog sync, the door-knock and solidarity
// snapshots, the mobilize sync, the invite audit, the growth report — and
// handing it to VAN would make an export job's metadata a credential for all
// of them.
//
// What goes in the URL instead is an HMAC keyed by that secret over the map
// route id: enough for the callback to prove it handed out this exact URL,
// useless anywhere else. The secret itself never leaves this host, the token
// is scoped to one turf, and it does not authenticate `?key=` on any other
// route because those compare against the raw secret.
//
// The token is not a bearer credential for anything that reads data — see the
// callback route: a valid token buys a queue drain and nothing more, and every
// download URL is re-read through the authenticated API rather than taken from
// the request. Scoping it per turf is defence in depth, not the only control.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hex HMAC-SHA256 of `mapRouteId` under `secret`. Truncated to 32 hex chars
 *  (128 bits) — far past guessing, and short enough that the URL VAN stores
 *  stays readable in their UI. */
export function signWebhookToken(secret: string, mapRouteId: number): string {
	return createHmac('sha256', secret).update(`van-export:${mapRouteId}`).digest('hex').slice(0, 32);
}

/** Constant-time check of a token against `mapRouteId`. False for any
 *  malformed input rather than throwing — this runs on unauthenticated
 *  requests, so a crafted query string must not produce a 500. */
export function verifyWebhookToken(secret: string, mapRouteId: number, token: string): boolean {
	if (!secret || !Number.isInteger(mapRouteId) || !token) return false;
	const expected = Buffer.from(signWebhookToken(secret, mapRouteId), 'utf8');
	const actual = Buffer.from(token, 'utf8');
	// timingSafeEqual throws on a length mismatch, which would itself leak the
	// length. The token is a fixed-width hex digest, so an unequal length is
	// simply wrong.
	if (expected.length !== actual.length) return false;
	return timingSafeEqual(expected, actual);
}

/**
 * The callback URL registered on one turf's export job.
 *
 * Built per turf rather than once per run because the token is per turf — the
 * worker calls this immediately before each POST /exportJobs.
 */
export function exportCallbackUrl(appUrl: string, secret: string, mapRouteId: number): string {
	const base = appUrl.replace(/\/+$/, '');
	const token = signWebhookToken(secret, mapRouteId);
	return `${base}/api/internal/van-export-callback?turf=${mapRouteId}&token=${token}`;
}

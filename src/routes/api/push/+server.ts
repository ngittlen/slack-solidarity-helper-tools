import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import {
	claimPushDevice,
	disablePushDevice,
	enablePushDevice,
	parseSubscription,
	pushPublicKey,
} from '$lib/server/push.js';

// Push notifications for one browser and the person using it, from /turfs and
// the root layout. Each person has their own on/off on a shared browser; the
// browser only gets its current user's notices (src/lib/server/push.ts).
//
// GET: the VAPID public key the browser subscribes with, or null when push is
//      not configured (the page then hides the switch); and whether this
//      person's turf messages otherwise come by Slack.
// POST { action: 'claim', subscription }: this person is using the site on
//      this browser, which already has a subscription. Makes it theirs, and
//      answers { enabled, recipient }: whether they have turned notifications
//      on here, and who the service worker should show messages in full for.
// POST { action: 'on', subscription }: turn them on for this person here.
//      Answers { recipient }.
// DELETE { endpoint }: turn them off for this person here. Answers
//      { othersEnabled }, so the page leaves the browser subscribed for anyone
//      else who wants them.
//
// Any signed-in user, Slack or Google or Apple: push is how a holder hears
// about their turf (van/holder-notices.ts), and the ids are the session's.

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session) return json({ error: 'Not signed in' }, { status: 401 });
	// Whether pushes replace this person's Slack DMs, or the page's notices:
	// the switch says which.
	return json({ publicKey: pushPublicKey(), viaSlack: locals.session.authProvider === undefined });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) return json({ error: 'Not signed in' }, { status: 401 });
	if (!pushPublicKey()) return json({ error: 'Notifications are not set up' }, { status: 503 });
	let body: { action?: unknown; subscription?: unknown };
	try {
		body = (await request.json()) as { action?: unknown; subscription?: unknown };
	} catch {
		return json({ error: 'Malformed request' }, { status: 400 });
	}
	const subscription = parseSubscription(body.subscription);
	if (!subscription) return json({ error: 'Malformed subscription' }, { status: 400 });
	if (body.action === 'claim') {
		return json(await claimPushDevice(db, session.slackUserId, subscription));
	}
	if (body.action === 'on') {
		return json(await enablePushDevice(db, session.slackUserId, subscription));
	}
	return json({ error: 'Unknown action' }, { status: 400 });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	const session = locals.session;
	if (!session) return json({ error: 'Not signed in' }, { status: 401 });
	let endpoint: unknown;
	try {
		({ endpoint } = (await request.json()) as { endpoint?: unknown });
	} catch {
		return json({ error: 'Malformed request' }, { status: 400 });
	}
	if (typeof endpoint !== 'string') return json({ error: 'Malformed request' }, { status: 400 });
	return json(await disablePushDevice(db, session.slackUserId, endpoint));
};

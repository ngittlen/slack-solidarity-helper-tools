// Web push to the browsers a volunteer opted in on, with the header's bell.
//
// A browser is a push_devices row: the endpoint its push service (Google,
// Mozilla, Microsoft, Apple) handed out, and the keys to encrypt for it. It
// has one endpoint for the whole site, whoever is using it, so each person's
// own on/off is a push_opt_ins row, and a device is sent only its current
// user's notices: whoever last used the site on it (claimPushDevice), until
// they log out on it (releasePushDevice). Two people sharing a phone keep
// their own settings, and neither sees the other's turf.
//
// A push service holds a message for a device that is off (PUSH_TTL_SECONDS),
// so one sent while A was the current user can arrive after B has taken the
// phone over. Each message therefore says who it is for (pushRecipient), the
// page tells the service worker who is using the browser, and the worker
// shows a message for anyone else only as "You have a turf update".
//
// Sending is one signed POST per device, through `web-push`; the push services
// are free and need no account, only the VAPID key pair (VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY in env.ts).
//
// sendPush never throws, and says whether any device took the message, all
// of them failed, or there were none: holder-notices.ts falls back to Slack
// or the page when nothing took it, so a phone that was wiped does not cost
// anyone a warning, and retries a push-only notice that failed.
//
// The server POSTs to whatever endpoint a browser hands it, so only the push
// services' own hosts are accepted (PUSH_SERVICE_HOSTS), each user is opted
// in on at most MAX_PUSH_DEVICES, and every send has a timeout: otherwise a signed-in
// user could aim the sync's sends at any host, as many times as they liked.
//
// PRIVACY.md ("Push notifications, if you turn them on") says what a row
// holds and every way it is deleted. Change the two together.

import { createHash } from 'node:crypto';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import webpush from 'web-push';
import { APP_URL, VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY } from './env.js';
import { pushDevices, pushOptIns } from './schema.js';
import { errMessage } from '../err-message.js';

type Db = ReturnType<typeof drizzle>;

const LOG = '[push]';

/** Failed sends in a row, other than "gone", before a device is dropped. */
export const MAX_PUSH_FAILURES = 5;
/** Devices one user may be opted in on. A new one past this drops their
 *  oldest. A phone, a laptop and a few spares. */
export const MAX_PUSH_DEVICES = 10;
/** How long one send may take. Sends run inside the van sync, one device
 *  after another, so a host that hangs must not hold the sync with it. */
const PUSH_TIMEOUT_MS = 10_000;

/** Where browsers' push services take messages: Chrome and Edge (FCM),
 *  Firefox (Mozilla autopush), Edge on Windows (WNS) and Safari (Apple). An
 *  exact host, or `.suffix` for any host under it. */
const PUSH_SERVICE_HOSTS = [
	'fcm.googleapis.com',
	'android.googleapis.com',
	'.push.services.mozilla.com',
	'.notify.windows.com',
	'web.push.apple.com',
	'.push.apple.com',
];

function isPushServiceHost(host: string): boolean {
	return PUSH_SERVICE_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
}
/** How long a push service holds a message for a device that is off. Every
 *  notice is about a claim measured in hours. */
const PUSH_TTL_SECONDS = 6 * 60 * 60;

/** What the service worker shows (src/service-worker.ts). */
export interface PushMessage {
	title: string;
	body: string;
	/** Same-site path opened when the notification is tapped. */
	url: string;
	/** A later message with the same tag replaces the earlier one. */
	tag?: string;
}

/** What a browser's PushSubscription.toJSON() gives. */
export interface PushSubscriptionInput {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export type SendFn = (
	subscription: PushSubscriptionInput,
	payload: string,
	options: webpush.RequestOptions,
) => Promise<unknown>;

export function pushConfigured(): boolean {
	return VAPID_PUBLIC_KEY !== '' && VAPID_PRIVATE_KEY !== '';
}

export function pushPublicKey(): string | null {
	return pushConfigured() ? VAPID_PUBLIC_KEY : null;
}

/** A browser's subscription, checked: an https endpoint on a known push
 *  service. Anything else would have us POST wherever a client said. */
export function parseSubscription(raw: unknown): PushSubscriptionInput | null {
	if (!raw || typeof raw !== 'object') return null;
	const { endpoint, keys } = raw as { endpoint?: unknown; keys?: unknown };
	if (typeof endpoint !== 'string' || endpoint.length > 1000) return null;
	try {
		const url = new URL(endpoint);
		if (url.protocol !== 'https:' || url.port !== '' || !isPushServiceHost(url.hostname)) {
			return null;
		}
	} catch {
		return null;
	}
	if (!keys || typeof keys !== 'object') return null;
	const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
	if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
	if (p256dh.length === 0 || p256dh.length > 200 || auth.length === 0 || auth.length > 100) {
		return null;
	}
	return { endpoint, keys: { p256dh, auth } };
}

/**
 * Who a message is for, as the service worker compares it: opaque, so a
 * payload never carries an account id, and stable, so the page can be told
 * its own. Not a secret — the worker only uses it to decide what to show.
 */
export function pushRecipient(userId: string): string {
	return createHash('sha256').update(`push-recipient:${userId}`).digest('base64url').slice(0, 22);
}

/** Delete devices nobody is opted in on any more: nothing will be sent
 *  to them, so there is no reason to keep their address. */
async function dropUnwantedDevices(db: Db): Promise<void> {
	await db
		.delete(pushDevices)
		.where(notInArray(pushDevices.id, db.select({ id: pushOptIns.deviceId }).from(pushOptIns)));
}

/** A device and everyone's opt-in on it. */
async function deleteDevice(db: Db, deviceId: number): Promise<void> {
	await db.batch([
		db.delete(pushOptIns).where(eq(pushOptIns.deviceId, deviceId)),
		db.delete(pushDevices).where(eq(pushDevices.id, deviceId)),
	]);
}

/**
 * `userId` is using the site on this browser: make them its current user, so
 * it gets their notices and nobody else's. Says whether they have turned
 * notifications on here. A browser this app has no record of stays that way
 * until someone turns them on.
 */
export async function claimPushDevice(
	db: Db,
	userId: string,
	sub: PushSubscriptionInput,
): Promise<{ enabled: boolean; recipient: string }> {
	const [device] = await db
		.update(pushDevices)
		.set({ currentUserId: userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
		.where(eq(pushDevices.endpoint, sub.endpoint))
		.returning({ id: pushDevices.id });
	const recipient = pushRecipient(userId);
	if (!device) return { enabled: false, recipient };
	const [optIn] = await db
		.select({ userId: pushOptIns.userId })
		.from(pushOptIns)
		.where(and(eq(pushOptIns.deviceId, device.id), eq(pushOptIns.userId, userId)));
	return { enabled: optIn !== undefined, recipient };
}

/** Turn `userId`'s notifications on for this browser, which becomes theirs
 *  (claimPushDevice). Past MAX_PUSH_DEVICES, their oldest opt-ins go. */
export async function enablePushDevice(
	db: Db,
	userId: string,
	sub: PushSubscriptionInput,
	now: Date = new Date(),
): Promise<{ recipient: string }> {
	const nowIso = now.toISOString();
	const [device] = await db
		.insert(pushDevices)
		.values({
			endpoint: sub.endpoint,
			p256dh: sub.keys.p256dh,
			auth: sub.keys.auth,
			currentUserId: userId,
			createdAt: nowIso,
		})
		.onConflictDoUpdate({
			target: pushDevices.endpoint,
			set: {
				p256dh: sub.keys.p256dh,
				auth: sub.keys.auth,
				currentUserId: userId,
				failures: 0,
			},
		})
		.returning({ id: pushDevices.id });
	await db
		.insert(pushOptIns)
		.values({ deviceId: device!.id, userId, createdAt: nowIso })
		.onConflictDoUpdate({
			target: [pushOptIns.deviceId, pushOptIns.userId],
			set: { createdAt: nowIso },
		});
	const newest = db
		.select({ deviceId: pushOptIns.deviceId })
		.from(pushOptIns)
		.where(eq(pushOptIns.userId, userId))
		.orderBy(desc(pushOptIns.createdAt), desc(pushOptIns.deviceId))
		.limit(MAX_PUSH_DEVICES);
	await db
		.delete(pushOptIns)
		.where(and(eq(pushOptIns.userId, userId), notInArray(pushOptIns.deviceId, newest)));
	await dropUnwantedDevices(db);
	return { recipient: pushRecipient(userId) };
}

/**
 * Turn `userId`'s notifications off for this browser. Anyone else's setting
 * on it is left alone; `othersEnabled` says whether there are any, so the
 * page knows whether to unsubscribe the browser itself. With nobody left, the
 * device is deleted.
 */
export async function disablePushDevice(
	db: Db,
	userId: string,
	endpoint: string,
): Promise<{ othersEnabled: boolean }> {
	const [device] = await db
		.select({ id: pushDevices.id })
		.from(pushDevices)
		.where(eq(pushDevices.endpoint, endpoint));
	if (!device) return { othersEnabled: false };
	await db
		.delete(pushOptIns)
		.where(and(eq(pushOptIns.deviceId, device.id), eq(pushOptIns.userId, userId)));
	const [other] = await db
		.select({ userId: pushOptIns.userId })
		.from(pushOptIns)
		.where(eq(pushOptIns.deviceId, device.id))
		.limit(1);
	if (other) return { othersEnabled: true };
	await deleteDevice(db, device.id);
	return { othersEnabled: false };
}

/** `userId` logged out on this browser: nobody's notices go to it until
 *  someone uses the site there again. Only theirs to give up — a browser
 *  someone else has since claimed is left alone. */
export async function releasePushDevice(db: Db, userId: string, endpoint: string): Promise<void> {
	await db
		.update(pushDevices)
		.set({ currentUserId: null })
		.where(and(eq(pushDevices.endpoint, endpoint), eq(pushDevices.currentUserId, userId)));
}

let vapidSet = false;
const defaultSend: SendFn = (subscription, payload, options) => {
	if (!vapidSet) {
		// The subject is how a push service reaches whoever runs the app.
		webpush.setVapidDetails(APP_URL || 'https://localhost', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
		vapidSet = true;
	}
	return webpush.sendNotification(subscription, payload, options);
};

function statusOf(err: unknown): number | null {
	const code = (err as { statusCode?: unknown })?.statusCode;
	return typeof code === 'number' ? code : null;
}

/** What a push came to: at least one device took it, every device failed
 *  (or the devices could not be read), or the user has none to send to —
 *  none opted in, or none they are the current user of, or push is not set
 *  up. */
export type PushOutcome = 'sent' | 'failed' | 'no-devices';

/**
 * Push `message` to every device `userId` opted in on and is the current
 * user of. Never throws.
 */
export async function sendPush(
	db: Db,
	userId: string,
	message: PushMessage,
	options: { send?: SendFn; now?: Date } = {},
): Promise<PushOutcome> {
	const nowIso = (options.now ?? new Date()).toISOString();
	try {
		if (!options.send && !pushConfigured()) return 'no-devices';
		const send = options.send ?? defaultSend;
		const devices = await db
			.select({
				id: pushDevices.id,
				endpoint: pushDevices.endpoint,
				p256dh: pushDevices.p256dh,
				auth: pushDevices.auth,
				failures: pushDevices.failures,
			})
			.from(pushDevices)
			.innerJoin(pushOptIns, eq(pushOptIns.deviceId, pushDevices.id))
			.where(and(eq(pushOptIns.userId, userId), eq(pushDevices.currentUserId, userId)));
		if (devices.length === 0) return 'no-devices';
		const payload = JSON.stringify({ ...message, for: pushRecipient(userId) });
		let delivered = false;
		for (const device of devices) {
			try {
				await send(
					{ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
					payload,
					{
						TTL: PUSH_TTL_SECONDS,
						urgency: 'high',
						timeout: PUSH_TIMEOUT_MS,
						...(message.tag ? { topic: topic(message.tag) } : {}),
					},
				);
				delivered = true;
				await db
					.update(pushDevices)
					.set({ lastSentAt: nowIso, failures: 0 })
					.where(eq(pushDevices.id, device.id));
			} catch (err) {
				const status = statusOf(err);
				// 404/410: the browser unsubscribed or the app was uninstalled.
				// The endpoint will never work again.
				if (status === 404 || status === 410 || device.failures + 1 >= MAX_PUSH_FAILURES) {
					await deleteDevice(db, device.id);
				} else {
					await db
						.update(pushDevices)
						.set({ failures: device.failures + 1 })
						.where(eq(pushDevices.id, device.id));
				}
				console.warn(
					`${LOG} send to ${userId} failed (${status ?? 'no status'}):`,
					errMessage(err),
				);
			}
		}
		return delivered ? 'sent' : 'failed';
	} catch (err) {
		console.error(`${LOG} could not push to ${userId}:`, errMessage(err));
		return 'failed';
	}
}

/** A push service's Topic header: at most 32 URL-safe base64 characters. A
 *  queued message with the same topic is replaced rather than piled up. */
function topic(tag: string): string {
	return tag.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
}

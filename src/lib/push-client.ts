// The browser half of push notifications (src/lib/server/push.ts): finding
// this browser's subscription, telling the server who is using it, and
// telling the service worker the same (push-display.ts).
//
// Used by the header's bell (nav/NotificationToggle.svelte), which claims the
// browser on every signed-in page load so a shared device only gets the
// notices of whoever used the site on it last, and by "Log out" in the root
// layout. One claim per page load (see claimPushDevice).

import type { RecipientMessage } from './push-display.js';

/** This browser's push subscription for the site, when it has one and may
 *  show notifications. Null otherwise, and never throws. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
	try {
		if (!('serviceWorker' in navigator) || !('Notification' in window)) return null;
		if (Notification.permission !== 'granted') return null;
		const registration = await navigator.serviceWorker.getRegistration();
		return (await registration?.pushManager.getSubscription()) ?? null;
	} catch {
		return null;
	}
}

/** Tell the service worker whose messages to show in full on this browser:
 *  null when nobody's (logging out). Never throws. */
export async function tellServiceWorker(recipient: string | null): Promise<void> {
	try {
		if (!('serviceWorker' in navigator)) return;
		// getRegistration, not `ready`: `ready` never settles on a page with no
		// worker, and Log out waits on this.
		const registration = await navigator.serviceWorker.getRegistration();
		const message: RecipientMessage = { type: 'push-recipient', recipient };
		registration?.active?.postMessage(message);
	} catch {
		// Nothing to do: the worker then shows messages as generic updates.
	}
}

export interface PushClaim {
	enabled: boolean;
	recipient: string;
}

/** The page load's claim, made once however often it is asked for. Forgotten
 *  when this person turns notifications on or off here, and when it failed,
 *  so the next ask tries again. */
let claim: { endpoint: string; result: Promise<PushClaim | null> } | null = null;

/** Make the signed-in person this browser's current user, on the server and
 *  in the service worker. Says whether they have notifications on here; null
 *  when the server could not say. */
export function claimPushDevice(subscription: PushSubscription): Promise<PushClaim | null> {
	if (claim?.endpoint !== subscription.endpoint) {
		const entry = { endpoint: subscription.endpoint, result: requestClaim(subscription) };
		claim = entry;
		void entry.result.then((result) => {
			if (result === null && claim === entry) claim = null;
		});
	}
	return claim.result;
}

/** Turning notifications on or off changes the answer a claim gave. */
export function forgetPushClaim(): void {
	claim = null;
}

async function requestClaim(subscription: PushSubscription): Promise<PushClaim | null> {
	try {
		const res = await fetch('/api/push', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'claim', subscription: subscription.toJSON() }),
		});
		if (!res.ok) return null;
		const result = (await res.json()) as PushClaim;
		await tellServiceWorker(result.recipient);
		return result;
	} catch {
		return null;
	}
}

/** The VAPID key as the bytes PushManager.subscribe wants. */
export function pushKeyBytes(base64url: string): Uint8Array<ArrayBuffer> {
	const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
		.replace(/-/g, '+')
		.replace(/_/g, '/');
	const raw = atob(base64);
	const bytes = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

/**
 * Whether `subscription` was made with the server's current VAPID key. One
 * made with a key since replaced can never be sent to. True when the browser
 * does not say which key it used: there is then nothing to compare.
 */
export function madeWithKey(subscription: PushSubscription, publicKey: string): boolean {
	const used = subscription.options?.applicationServerKey;
	if (!used) return true;
	const a = new Uint8Array(used);
	const b = pushKeyBytes(publicKey);
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** iPhone and iPad Safari allow push only to a site added to the Home Screen
 *  and opened from there. */
export function pushNeedsInstall(): boolean {
	const ios =
		/iPhone|iPad|iPod/.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
	const standalone =
		window.matchMedia('(display-mode: standalone)').matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true;
	return ios && !standalone;
}

export function pushSupported(): boolean {
	return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Tell the server this browser should get the signed-in person's
 *  notifications. */
async function enablePush(subscription: PushSubscription): Promise<boolean> {
	forgetPushClaim();
	const res = await fetch('/api/push', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action: 'on', subscription: subscription.toJSON() }),
	});
	if (!res.ok) return false;
	const { recipient } = (await res.json()) as { recipient: string };
	await tellServiceWorker(recipient);
	return true;
}

/**
 * Turn notifications on for the signed-in person on this browser: ask
 * permission, subscribe (reusing the browser's subscription when someone
 * else on it already has one), and tell the server. The permission the
 * browser gave, with the subscription when it worked. Throws when saving
 * failed.
 */
export async function turnOnPush(
	publicKey: string,
): Promise<{ permission: NotificationPermission; subscription: PushSubscription | null }> {
	const permission = await Notification.requestPermission();
	if (permission !== 'granted') return { permission, subscription: null };
	// One made with a VAPID key since replaced can never be sent to, so it is
	// replaced too; anyone else on this browser then turns theirs on again.
	const registration = await navigator.serviceWorker.ready;
	let existing = await registration.pushManager.getSubscription();
	if (existing && !madeWithKey(existing, publicKey)) {
		await existing.unsubscribe();
		existing = null;
	}
	const subscription =
		existing ??
		(await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: pushKeyBytes(publicKey),
		}));
	if (!(await enablePush(subscription))) {
		if (!existing) await subscription.unsubscribe().catch(() => {});
		throw new Error('save failed');
	}
	return { permission, subscription };
}

/**
 * The VAPID key, when this browser could take notifications for the signed-in
 * person but doesn't yet: what the nearby-walk alerts offer (specs/015-
 * mentor-walks, User Story 7). Null when it already does, can't, or was
 * refused. Never throws.
 */
export async function pushOfferKey(): Promise<string | null> {
	try {
		if (!pushSupported() || pushNeedsInstall() || Notification.permission === 'denied') {
			return null;
		}
		const res = await fetch('/api/push');
		if (!res.ok) return null;
		const { publicKey } = (await res.json()) as { publicKey: string | null };
		if (!publicKey) return null;
		const existing = await currentPushSubscription();
		const claimed = existing ? await claimPushDevice(existing) : null;
		return existing && claimed?.enabled && madeWithKey(existing, publicKey) ? null : publicKey;
	} catch {
		return null;
	}
}

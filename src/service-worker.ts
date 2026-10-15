/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Push notifications only. There is no fetch handler on purpose: no page is
// cached, so the app behaves exactly as it does without a service worker.
// SvelteKit registers this file itself.
//
// The payload is src/lib/server/push.ts's PushMessage plus who it is for.
// The page says who is using this browser (a 'push-recipient' message from
// push-client.ts), kept in Cache Storage because a worker is stopped between
// events; a message for anyone else is shown only as a generic update
// (push-display.ts).

import { isRecipientMessage, notificationFor, type PushPayload } from '$lib/push-display.js';

const sw = self as unknown as ServiceWorkerGlobalScope;

/** Where the current recipient is kept: one entry in its own cache. */
const STATE_CACHE = 'push-state';
const RECIPIENT_KEY = '/__push-recipient';

async function currentRecipient(): Promise<string | null> {
	try {
		const res = await (await caches.open(STATE_CACHE)).match(RECIPIENT_KEY);
		return res ? await res.text() : null;
	} catch {
		return null;
	}
}

async function setRecipient(recipient: string | null): Promise<void> {
	const cache = await caches.open(STATE_CACHE);
	if (recipient === null) await cache.delete(RECIPIENT_KEY);
	else await cache.put(RECIPIENT_KEY, new Response(recipient));
}

sw.addEventListener('message', (event) => {
	if (!isRecipientMessage(event.data)) return;
	event.waitUntil(setRecipient(event.data.recipient));
});

sw.addEventListener('install', () => {
	void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(sw.clients.claim());
});

sw.addEventListener('push', (event) => {
	let payload: PushPayload;
	try {
		payload = event.data?.json() as PushPayload;
	} catch {
		return;
	}
	if (!payload?.title) return;
	event.waitUntil(
		(async () => {
			const shown = notificationFor(payload, await currentRecipient());
			await sw.registration.showNotification(shown.title, {
				body: shown.body,
				icon: '/icon-192.png',
				tag: shown.tag,
				data: { url: shown.url },
			});
		})(),
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const raw = (event.notification.data as { url?: unknown } | null)?.url;
	// Only ever a page of this site, whatever the payload says.
	const target = new URL(typeof raw === 'string' ? raw : '/turfs', sw.location.origin);
	const url = target.origin === sw.location.origin ? target.href : `${sw.location.origin}/turfs`;
	event.waitUntil(
		(async () => {
			const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const open = windows.find((w) => new URL(w.url).origin === sw.location.origin);
			if (open) {
				try {
					await open.focus();
					await open.navigate(url);
					return;
				} catch {
					// navigate() refuses a tab this worker does not control (one
					// opened with a hard reload, say). A new window still gets
					// the volunteer there.
				}
			}
			await sw.clients.openWindow(url);
		})(),
	);
});

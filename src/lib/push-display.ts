// What the service worker shows for a push (src/service-worker.ts), kept out
// of the worker so it can be tested.
//
// A push service holds a message for a device that is off, so one meant for
// whoever used this browser earlier can arrive after someone else has taken
// it over, or after they logged out on it. The page tells the worker who is
// using the browser now (push-client.ts); a message for anyone else is shown
// only as a generic update, never its text. It cannot be dropped instead:
// browsers require a push to show something, and penalise a site that does
// not.

/** The payload src/lib/server/push.ts sends: its PushMessage, plus who it is
 *  for (pushRecipient). */
export interface PushPayload {
	title: string;
	body: string;
	url: string;
	tag?: string;
	for?: string;
}

export interface ShownNotification {
	title: string;
	body: string;
	url: string;
	tag?: string;
}

/** Shown in place of a message meant for someone else on this browser. */
export const GENERIC_NOTIFICATION: ShownNotification = {
	title: 'You have a turf update',
	body: 'Open the app to see it.',
	url: '/turfs',
	tag: 'generic',
};

/**
 * The notification to show for `payload` on a browser whose current user is
 * `current` (null when nobody is, or the worker was never told). In full only
 * when the two match; a payload that says nothing about who it is for is
 * treated as someone else's.
 */
export function notificationFor(payload: PushPayload, current: string | null): ShownNotification {
	if (!payload.for || payload.for !== current) return GENERIC_NOTIFICATION;
	return { title: payload.title, body: payload.body, url: payload.url, tag: payload.tag };
}

/** The message a page posts to the worker to say who is using the browser. */
export interface RecipientMessage {
	type: 'push-recipient';
	recipient: string | null;
}

export function isRecipientMessage(data: unknown): data is RecipientMessage {
	if (!data || typeof data !== 'object') return false;
	const { type, recipient } = data as { type?: unknown; recipient?: unknown };
	return type === 'push-recipient' && (recipient === null || typeof recipient === 'string');
}

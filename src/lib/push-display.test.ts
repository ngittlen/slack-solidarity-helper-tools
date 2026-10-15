import { describe, it, expect } from 'vitest';
import { GENERIC_NOTIFICATION, isRecipientMessage, notificationFor } from './push-display.js';

const PAYLOAD = {
	title: 'Your turf expires soon',
	body: 'Kent 03 Turf 05 expires in about 6 hours.',
	url: '/turfs?chapter=4',
	tag: 'expiry',
	for: 'R1',
};

describe('notificationFor', () => {
	it("shows a message in full to the person it's for", () => {
		expect(notificationFor(PAYLOAD, 'R1')).toEqual({
			title: PAYLOAD.title,
			body: PAYLOAD.body,
			url: PAYLOAD.url,
			tag: 'expiry',
		});
	});

	// Queued while the phone was off, arriving after someone else took it over.
	it('shows only a generic update to anyone else on the browser', () => {
		expect(notificationFor(PAYLOAD, 'R2')).toEqual(GENERIC_NOTIFICATION);
		expect(GENERIC_NOTIFICATION.body).not.toContain('Kent');
	});

	it('shows only a generic update once they logged out, or when never told', () => {
		expect(notificationFor(PAYLOAD, null)).toEqual(GENERIC_NOTIFICATION);
	});

	it("treats a message that doesn't say who it's for as someone else's", () => {
		expect(notificationFor({ ...PAYLOAD, for: undefined }, 'R1')).toEqual(GENERIC_NOTIFICATION);
	});
});

describe('isRecipientMessage', () => {
	it('takes a recipient or null, and nothing else', () => {
		expect(isRecipientMessage({ type: 'push-recipient', recipient: 'R1' })).toBe(true);
		expect(isRecipientMessage({ type: 'push-recipient', recipient: null })).toBe(true);
		expect(isRecipientMessage({ type: 'push-recipient', recipient: 1 })).toBe(false);
		expect(isRecipientMessage({ type: 'other', recipient: 'R1' })).toBe(false);
		expect(isRecipientMessage(null)).toBe(false);
	});
});

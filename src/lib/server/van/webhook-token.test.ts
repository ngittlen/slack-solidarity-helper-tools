import { describe, it, expect } from 'vitest';
import { signWebhookToken, verifyWebhookToken, exportCallbackUrl } from './webhook-token.js';

const SECRET = 'cron-secret-not-in-any-url';

describe('signWebhookToken', () => {
	it('is stable for a turf and different for every other one', () => {
		expect(signWebhookToken(SECRET, 585052)).toBe(signWebhookToken(SECRET, 585052));
		expect(signWebhookToken(SECRET, 585052)).not.toBe(signWebhookToken(SECRET, 585053));
	});

	it('is a fixed-width hex digest', () => {
		expect(signWebhookToken(SECRET, 1)).toMatch(/^[0-9a-f]{32}$/);
	});

	// The whole point: VAN keeps this string, so it must not be the secret and
	// must not be reversible into it.
	it('never contains the secret', () => {
		expect(signWebhookToken(SECRET, 100)).not.toContain(SECRET);
	});

	it('changes with the secret, so rotating it invalidates outstanding tokens', () => {
		expect(signWebhookToken(SECRET, 100)).not.toBe(signWebhookToken('rotated', 100));
	});
});

describe('verifyWebhookToken', () => {
	it('accepts the token it issued for that turf', () => {
		expect(verifyWebhookToken(SECRET, 100, signWebhookToken(SECRET, 100))).toBe(true);
	});

	// A token good for every turf would be a shared secret with extra steps.
	it('refuses a valid token presented for a different turf', () => {
		expect(verifyWebhookToken(SECRET, 101, signWebhookToken(SECRET, 100))).toBe(false);
	});

	it('refuses a token signed with a different secret', () => {
		expect(verifyWebhookToken(SECRET, 100, signWebhookToken('other', 100))).toBe(false);
	});

	// This runs on unauthenticated requests, so a crafted query string has to
	// produce `false`, never a 500.
	it('refuses malformed input rather than throwing', () => {
		expect(verifyWebhookToken(SECRET, 100, '')).toBe(false);
		expect(verifyWebhookToken(SECRET, 100, 'short')).toBe(false);
		expect(verifyWebhookToken(SECRET, 100, 'z'.repeat(32))).toBe(false);
		expect(verifyWebhookToken(SECRET, NaN, signWebhookToken(SECRET, 100))).toBe(false);
		expect(verifyWebhookToken(SECRET, 1.5, signWebhookToken(SECRET, 100))).toBe(false);
		expect(verifyWebhookToken('', 100, 'anything')).toBe(false);
	});
});

describe('exportCallbackUrl', () => {
	it('points at our own callback, carrying the turf and its token', () => {
		const url = new URL(exportCallbackUrl('https://app.example', SECRET, 585052));
		expect(url.origin).toBe('https://app.example');
		expect(url.pathname).toBe('/api/internal/van-export-callback');
		expect(url.searchParams.get('turf')).toBe('585052');
		expect(verifyWebhookToken(SECRET, 585052, url.searchParams.get('token')!)).toBe(true);
	});

	// VAN stores this string and echoes it back on every read of the job. The
	// secret gates seven other internal endpoints; it must not be in here.
	it('never carries the cron secret itself', () => {
		expect(exportCallbackUrl('https://app.example', SECRET, 100)).not.toContain(SECRET);
		expect(exportCallbackUrl('https://app.example', SECRET, 100)).not.toContain('key=');
	});

	it('tolerates a trailing slash on APP_URL', () => {
		expect(exportCallbackUrl('https://app.example//', SECRET, 100)).toContain(
			'https://app.example/api/internal/van-export-callback',
		);
	});
});

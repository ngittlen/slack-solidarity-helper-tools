import { describe, it, expect } from 'vitest';
import { isCurrentPath } from './menu-helpers.js';

describe('isCurrentPath', () => {
	it('returns true for an exact match', () => {
		expect(isCurrentPath('/pending', '/pending')).toBe(true);
	});

	it('normalizes a trailing slash on the pathname', () => {
		expect(isCurrentPath('/pending', '/pending/')).toBe(true);
	});

	it('normalizes a trailing slash on the itemHref', () => {
		expect(isCurrentPath('/pending/', '/pending')).toBe(true);
	});

	it('does NOT match a sub-path (no startsWith fallthrough)', () => {
		// Prevents accidental matches when sub-routes are added (e.g., /pending/123).
		expect(isCurrentPath('/pending', '/pending/anything')).toBe(false);
	});

	it('does not match distinct paths', () => {
		expect(isCurrentPath('/pending', '/settings')).toBe(false);
	});

	it('is case-sensitive (URL paths are case-sensitive per the standard)', () => {
		expect(isCurrentPath('/settings', '/PENDING')).toBe(false);
	});

	it('strips a query string from the pathname before comparing', () => {
		expect(isCurrentPath('/pending', '/pending?ref=email')).toBe(true);
	});

	it('strips a hash from the pathname before comparing', () => {
		expect(isCurrentPath('/pending', '/pending#section')).toBe(true);
	});

	it('matches root path against itself', () => {
		expect(isCurrentPath('/', '/')).toBe(true);
	});

	it('does not match root against a sub-route', () => {
		expect(isCurrentPath('/', '/pending')).toBe(false);
	});

	it('matches two empty strings', () => {
		expect(isCurrentPath('', '')).toBe(true);
	});

	it('does not match a non-empty href against an empty pathname', () => {
		expect(isCurrentPath('/pending', '')).toBe(false);
	});
});

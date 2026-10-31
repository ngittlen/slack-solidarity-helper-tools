import { describe, it, expect } from 'vitest';
import {
	sanitizeRedirectTarget,
	isAdminOnlyPath,
	resolvePostLoginRedirect,
	loginRedirectPath,
	isTurfCheckoutPath,
	withRedirectTo,
} from './post-login-redirect.js';

describe('sanitizeRedirectTarget', () => {
	it('keeps a same-origin path with its query string', () => {
		expect(sanitizeRedirectTarget('/members?user=U123')).toBe('/members?user=U123');
		expect(sanitizeRedirectTarget('/')).toBe('/');
	});

	it('rejects absolute URLs to another origin', () => {
		expect(sanitizeRedirectTarget('https://evil.example/steal')).toBeNull();
		expect(sanitizeRedirectTarget('http://evil.example')).toBeNull();
	});

	it('rejects protocol-relative URLs, which browsers follow off-site', () => {
		expect(sanitizeRedirectTarget('//evil.example/steal')).toBeNull();
		expect(sanitizeRedirectTarget('/\\evil.example/steal')).toBeNull();
	});

	it('rejects non-rooted and scheme-bearing values', () => {
		expect(sanitizeRedirectTarget('members')).toBeNull();
		expect(sanitizeRedirectTarget('javascript:alert(1)')).toBeNull();
	});

	it('rejects values carrying control characters', () => {
		expect(sanitizeRedirectTarget('/pending\nLocation: https://evil.example')).toBeNull();
	});

	it('rejects the auth routes so login cannot loop', () => {
		expect(sanitizeRedirectTarget('/auth/slack')).toBeNull();
		expect(sanitizeRedirectTarget('/auth/dev-login')).toBeNull();
		expect(sanitizeRedirectTarget('/auth/google')).toBeNull();
	});

	it('rejects the sign-in page, which only ever sends a signed-in visitor on', () => {
		expect(sanitizeRedirectTarget('/signin')).toBeNull();
		expect(sanitizeRedirectTarget('/signin?redirectTo=%2Fturfs')).toBeNull();
	});

	it('rejects empty, missing, and absurdly long values', () => {
		expect(sanitizeRedirectTarget(null)).toBeNull();
		expect(sanitizeRedirectTarget(undefined)).toBeNull();
		expect(sanitizeRedirectTarget('')).toBeNull();
		expect(sanitizeRedirectTarget('/' + 'a'.repeat(600))).toBeNull();
	});
});

describe('isAdminOnlyPath', () => {
	it('matches the admin pages and their sub-paths', () => {
		expect(isAdminOnlyPath('/pending')).toBe(true);
		expect(isAdminOnlyPath('/settings')).toBe(true);
		expect(isAdminOnlyPath('/members')).toBe(true);
		expect(isAdminOnlyPath('/members?user=U123')).toBe(true);
		expect(isAdminOnlyPath('/channel-chapter-diff')).toBe(true);
		expect(isAdminOnlyPath('/settings/deep/link')).toBe(true);
	});

	it('does not match pages that merely share a prefix', () => {
		expect(isAdminOnlyPath('/')).toBe(false);
		expect(isAdminOnlyPath('/pendingish')).toBe(false);
		expect(isAdminOnlyPath('/settings-export')).toBe(false);
	});
});

describe('resolvePostLoginRedirect', () => {
	describe('for a Google session', () => {
		const google = { isAdmin: false, authProvider: 'google' as const };

		it('returns to /turfs, query string and all', () => {
			expect(resolvePostLoginRedirect('/turfs', google)).toBe('/turfs');
			expect(resolvePostLoginRedirect('/turfs?chapter=12&zip=48104', google)).toBe(
				'/turfs?chapter=12&zip=48104',
			);
		});

		it('sends every other destination to /turfs, the dashboard included', () => {
			expect(resolvePostLoginRedirect('/', google)).toBe('/turfs');
			expect(resolvePostLoginRedirect('/settings', google)).toBe('/turfs');
			expect(resolvePostLoginRedirect('/turfs/organizer', google)).toBe('/turfs');
			expect(resolvePostLoginRedirect('/turfsx', google)).toBe('/turfs');
		});

		it('sends a missing or unsafe destination to /turfs', () => {
			expect(resolvePostLoginRedirect(null, google)).toBe('/turfs');
			expect(resolvePostLoginRedirect('https://evil.example', google)).toBe('/turfs');
		});

		it('ignores any role flags it is handed', () => {
			expect(
				resolvePostLoginRedirect('/settings', { ...google, isAdmin: true, isModerator: true }),
			).toBe('/turfs');
		});
	});

	describe('for an Apple session', () => {
		const apple = { isAdmin: false, authProvider: 'apple' as const };

		it('is confined to /turfs exactly like a Google one', () => {
			expect(resolvePostLoginRedirect('/turfs?chapter=12', apple)).toBe('/turfs?chapter=12');
			expect(resolvePostLoginRedirect('/settings', { ...apple, isAdmin: true })).toBe('/turfs');
			expect(resolvePostLoginRedirect(null, apple)).toBe('/turfs');
		});
	});

	it('returns the requested admin page for an admin', () => {
		expect(resolvePostLoginRedirect('/settings', { isAdmin: true })).toBe('/settings');
		expect(resolvePostLoginRedirect('/members?user=U123', { isAdmin: true })).toBe(
			'/members?user=U123',
		);
	});

	it('sends a non-admin who asked for an admin page to the root page', () => {
		expect(resolvePostLoginRedirect('/settings', { isAdmin: false })).toBe('/');
		expect(resolvePostLoginRedirect('/pending', { isAdmin: false })).toBe('/');
	});

	it('returns a moderator to the member and post-as-you pages, and no other admin page', () => {
		const moderator = { isAdmin: false, isModerator: true };
		expect(resolvePostLoginRedirect('/members?user=U123', moderator)).toBe('/members?user=U123');
		expect(resolvePostLoginRedirect('/members', moderator)).toBe('/members');
		expect(resolvePostLoginRedirect('/post-as-you', moderator)).toBe('/post-as-you');
		expect(resolvePostLoginRedirect('/settings', moderator)).toBe('/');
		expect(resolvePostLoginRedirect('/pending', moderator)).toBe('/');
	});

	it('does not send a plain member to /post-as-you', () => {
		expect(resolvePostLoginRedirect('/post-as-you', { isAdmin: false })).toBe('/');
	});

	it('does not treat a lookalike path as the member page', () => {
		const moderator = { isAdmin: false, isModerator: true };
		expect(resolvePostLoginRedirect('/membership', moderator)).toBe('/membership');
		expect(resolvePostLoginRedirect('/members', { isAdmin: false })).toBe('/');
	});

	it('returns a non-admin page to everyone who asked for it', () => {
		expect(resolvePostLoginRedirect('/?days=30', { isAdmin: false })).toBe('/?days=30');
	});

	it('falls back to the root page when there is nothing safe to return to', () => {
		expect(resolvePostLoginRedirect(null, { isAdmin: true })).toBe('/');
		expect(resolvePostLoginRedirect('https://evil.example', { isAdmin: true })).toBe('/');
	});
});

describe('loginRedirectPath', () => {
	it('carries the requested page as an encoded query parameter', () => {
		expect(loginRedirectPath(new URL('http://app.test/members?user=U123'))).toBe(
			'/signin?redirectTo=%2Fmembers%3Fuser%3DU123',
		);
	});

	it('leaves the login URL bare for the root page', () => {
		expect(loginRedirectPath(new URL('http://app.test/'))).toBe('/signin');
	});

	it('keeps the root page query string, which the dashboard reads', () => {
		expect(loginRedirectPath(new URL('http://app.test/?days=30'))).toBe(
			'/signin?redirectTo=%2F%3Fdays%3D30',
		);
	});
});

describe('isTurfCheckoutPath', () => {
	it('matches /turfs alone, with or without a query string', () => {
		expect(isTurfCheckoutPath('/turfs')).toBe(true);
		expect(isTurfCheckoutPath('/turfs/')).toBe(true);
		expect(isTurfCheckoutPath('/turfs?chapter=3')).toBe(true);
	});

	it('does not match the organizer pages under it, or lookalikes', () => {
		expect(isTurfCheckoutPath('/turfs/organizer')).toBe(false);
		expect(isTurfCheckoutPath('/turfs/activity')).toBe(false);
		expect(isTurfCheckoutPath('/turfsx')).toBe(false);
		expect(isTurfCheckoutPath('/')).toBe(false);
	});
});

describe('withRedirectTo', () => {
	it('leaves the URL bare for no destination or the root page', () => {
		expect(withRedirectTo('/auth/google', null)).toBe('/auth/google');
		expect(withRedirectTo('/auth/google', '/')).toBe('/auth/google');
	});

	it('encodes the destination', () => {
		expect(withRedirectTo('/auth/google', '/turfs?chapter=3')).toBe(
			'/auth/google?redirectTo=%2Fturfs%3Fchapter%3D3',
		);
	});
});

import { describe, it, expect } from 'vitest';
import { isPublicPath } from './public-paths.js';

describe('isPublicPath', () => {
	it('admits the policy pages and their conventional aliases', () => {
		expect(isPublicPath('/policies')).toBe(true);
		expect(isPublicPath('/privacy')).toBe(true);
		expect(isPublicPath('/security')).toBe(true);
	});

	it('tolerates a trailing slash and sub-paths', () => {
		expect(isPublicPath('/policies/')).toBe(true);
		expect(isPublicPath('/policies/anything')).toBe(true);
	});

	// The whole point of the allowlist is that it stays this short. A prefix
	// match must not turn into a wildcard that publishes a member's page
	// because its path happens to start with the same letters.
	it('does not admit a path that merely starts like a public one', () => {
		expect(isPublicPath('/policies-internal')).toBe(false);
		expect(isPublicPath('/privacy-report')).toBe(false);
		expect(isPublicPath('/securityaudit')).toBe(false);
	});

	it('keeps every real page behind the guard', () => {
		for (const path of [
			'/',
			'/pending',
			'/members',
			'/members/U123',
			'/settings',
			'/turfs',
			'/turfs/organizer',
			'/turfs/activity',
			'/dashboard/slack',
			'/dashboard/solidarity',
		]) {
			expect(isPublicPath(path), path).toBe(false);
		}
	});
});

import { describe, it, expect } from 'vitest';
import { load } from './+page.server.js';

function makeEvent(session: App.Locals['session']) {
	return { locals: { session } };
}

describe('pending +page.server load', () => {
	it('redirects to / when there is no session (layout guard runs concurrently, not first)', () => {
		expect(() => load(makeEvent(null) as never)).toThrowError(
			expect.objectContaining({ status: 302, location: '/' }),
		);
	});

	it('redirects non-admin users to /', () => {
		const session = { slackUserId: 'U1', slackUserName: 'Member', isAdmin: false };
		expect(() => load(makeEvent(session) as never)).toThrowError(
			expect.objectContaining({ status: 302, location: '/' }),
		);
	});

	it('returns page data for admins', () => {
		const session = { slackUserId: 'U1', slackUserName: 'Admin', isAdmin: true };
		expect(load(makeEvent(session) as never)).toEqual({
			userName: 'Admin',
			pageTitle: 'Pending Applicants',
		});
	});
});

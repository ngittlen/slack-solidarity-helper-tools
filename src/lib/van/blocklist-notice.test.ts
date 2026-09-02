import { describe, it, expect } from 'vitest';
import {
	renderBlockNotice,
	renderBlockedHolderDm,
	renderUnblockNotice,
} from './blocklist-notice.js';

const base = {
	targetSlackUserId: 'U_VOL',
	actorSlackUserId: 'U_ADMIN',
	reason: 'Left the campaign',
	releasedTurfNames: ['Turf 01', 'Turf 07'],
	sessionsRevoked: 2,
};

describe('renderBlockNotice', () => {
	it('leads with who did what to whom', () => {
		const text = renderBlockNotice(base);
		expect(text).toContain('<@U_VOL>');
		expect(text).toContain('<@U_ADMIN>');
		expect(text).toContain('blocked from turf checkout');
	});

	// Mentions rather than stored display names: they survive a rename and are
	// unambiguous when two people share a name.
	it('uses Slack mentions, not names', () => {
		expect(renderBlockNotice(base)).toMatch(/<@U_VOL>/);
	});

	it('includes the reason when one was given', () => {
		expect(renderBlockNotice(base)).toContain('Left the campaign');
	});

	it.each([
		['omitted', undefined],
		['empty', ''],
		['whitespace', '   '],
	])('omits the reason line when %s', (_label, reason) => {
		expect(renderBlockNotice({ ...base, reason })).not.toContain('Reason:');
	});

	// The side effect an organizer would otherwise have to discover: the block
	// quietly made someone else's turf claimable.
	it('names the turf it freed', () => {
		const text = renderBlockNotice(base);
		expect(text).toContain('Turf 01, Turf 07');
		expect(text).toContain('claimable by anyone');
	});

	it('says nothing about turf when none was held', () => {
		const text = renderBlockNotice({ ...base, releasedTurfNames: [] });
		expect(text).not.toContain('Freed');
		expect(text).not.toContain('claimable');
	});

	it.each([
		[1, ['Turf 01'], '1 turf '],
		[2, ['Turf 01', 'Turf 07'], '2 turfs '],
	])('pluralises %i turf correctly', (_n, names, expected) => {
		expect(renderBlockNotice({ ...base, releasedTurfNames: names })).toContain(expected);
	});

	it.each([
		[1, '1 session'],
		[3, '3 sessions'],
	])('pluralises %i revoked session correctly', (sessionsRevoked, expected) => {
		expect(renderBlockNotice({ ...base, sessionsRevoked })).toContain(expected);
	});

	it('omits the session line when none were revoked', () => {
		expect(renderBlockNotice({ ...base, sessionsRevoked: 0 })).not.toContain('Signed them out');
	});
});

describe('renderUnblockNotice', () => {
	it('names both people', () => {
		const text = renderUnblockNotice('U_VOL', 'U_ADMIN');
		expect(text).toContain('<@U_VOL>');
		expect(text).toContain('<@U_ADMIN>');
		expect(text).toContain('unblocked');
	});

	// An organizer who assumes unblocking hands the turf back will go looking
	// for turf that was re-claimed days ago.
	it('says what unblocking does not do', () => {
		expect(renderUnblockNotice('U_VOL', 'U_ADMIN')).toContain('is not returned');
	});
});

describe('renderBlockedHolderDm', () => {
	it('lists the turf that was taken', () => {
		const text = renderBlockedHolderDm(['Turf 01', 'Turf 07'])!;
		expect(text).toContain('Turf 01');
		expect(text).toContain('Turf 07');
	});

	// The failure this whole message exists to prevent.
	it('tells them not to head out', () => {
		expect(renderBlockedHolderDm(['Turf 01'])!).toContain("don't head out");
	});

	it.each([
		[['Turf 01'], 'Your turf has been released'],
		[['Turf 01', 'Turf 07'], 'Your turfs have been released'],
	])('agrees in number for %s', (names, expected) => {
		expect(renderBlockedHolderDm(names)!).toContain(expected);
	});

	// The reason is a note about a person written for other organizers. Relaying
	// it turns "your turf was released" into an argument the DM cannot hold.
	it('never carries the admin’s stated reason', () => {
		// The renderer has no parameter for it at all — this pins that shape, so
		// adding one later is a deliberate decision rather than a slip.
		expect(renderBlockedHolderDm.length).toBe(1);
	});

	// Silence beats an unprompted "you have been blocked" with no recourse in it.
	it('returns null when nothing was released', () => {
		expect(renderBlockedHolderDm([])).toBeNull();
	});
});

import { describe, it, expect } from 'vitest';
import { BLOCKED_MESSAGE, canBlock, turfAccess } from './access.js';

const volunteer = { slackUserId: 'U_VOL', isAdmin: false };
const admin = { slackUserId: 'U_ADMIN', isAdmin: true };
const SUPER = 'U_SUPER';

describe('turfAccess', () => {
	it('allows an ordinary signed-in volunteer', () => {
		expect(turfAccess(volunteer, new Set())).toEqual({ allowed: true });
	});

	it('denies a blocked volunteer', () => {
		const decision = turfAccess(volunteer, new Set(['U_VOL']));
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.reason).toBe('blocked');
			expect(decision.message).toBe(BLOCKED_MESSAGE);
		}
	});

	// The lockout guard: an admin on the block list stays in.
	it('never blocks an admin, even if listed', () => {
		expect(turfAccess(admin, new Set(['U_ADMIN']))).toEqual({ allowed: true });
	});

	it('never blocks the superuser, even if listed', () => {
		const su = { slackUserId: SUPER, isAdmin: false };
		expect(turfAccess(su, new Set([SUPER]), SUPER)).toEqual({ allowed: true });
	});

	it('blocks a non-admin when a superuser id is configured but does not match', () => {
		expect(turfAccess(volunteer, new Set(['U_VOL']), SUPER).allowed).toBe(false);
	});

	it('gives a message that explains and points somewhere, without accusing', () => {
		expect(BLOCKED_MESSAGE).toMatch(/organizer/i);
		expect(BLOCKED_MESSAGE).not.toMatch(/denied|forbidden|violation|banned/i);
	});
});

describe('canBlock', () => {
	const context = {
		adminSlackUserIds: new Set(['U_ADMIN', 'U_OTHER_ADMIN']),
		superuserSlackUserId: SUPER,
	};

	it('allows blocking an ordinary member', () => {
		expect(canBlock('U_ADMIN', 'U_VOL', context)).toEqual({ ok: true });
	});

	it('refuses blocking another admin, with a reason', () => {
		const d = canBlock('U_ADMIN', 'U_OTHER_ADMIN', context);
		expect(d).toMatchObject({ ok: false, reason: 'is-admin' });
		if (!d.ok) expect(d.message).toMatch(/admin access/i);
	});

	it('refuses blocking the superuser', () => {
		expect(canBlock('U_ADMIN', SUPER, context)).toMatchObject({
			ok: false,
			reason: 'is-superuser',
		});
	});

	it('refuses blocking yourself', () => {
		expect(canBlock('U_ADMIN', 'U_ADMIN', context)).toMatchObject({
			ok: false,
			reason: 'is-self',
		});
	});

	it('works with no superuser configured', () => {
		expect(canBlock('U_ADMIN', 'U_VOL', { adminSlackUserIds: new Set(['U_ADMIN']) })).toEqual({
			ok: true,
		});
	});
});

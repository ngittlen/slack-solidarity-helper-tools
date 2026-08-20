import { describe, it, expect } from 'vitest';
import {
	activeClaimFor,
	activeClaimsFor,
	canClaim,
	expiryFor,
	hoursRemaining,
	isActive,
	lapsedClaims,
	turfStatus,
	type ClaimSnapshot,
	type TurfSnapshot,
} from './checkout.js';

const NOW = new Date('2026-08-16T12:00:00.000Z');

const turf = (over: Partial<TurfSnapshot> = {}): TurfSnapshot => ({
	mapRouteId: 4101,
	printedListNumber: '35536742-78261',
	retiredAt: null,
	vanDistributedTo: null,
	doorCount: 91,
	...over,
});

const claim = (over: Partial<ClaimSnapshot> = {}): ClaimSnapshot => ({
	mapRouteId: 4101,
	slackUserId: 'U_ALICE',
	slackUserName: 'Alice',
	claimedAt: '2026-08-16T09:00:00.000Z',
	expiresAt: '2026-08-18T09:00:00.000Z',
	releasedAt: null,
	completedAt: null,
	...over,
});

describe('isActive', () => {
	it('is true for an unreleased, uncompleted, unexpired claim', () => {
		expect(isActive(claim(), NOW)).toBe(true);
	});

	it('is false once released, completed, or lapsed', () => {
		expect(isActive(claim({ releasedAt: '2026-08-16T10:00:00.000Z' }), NOW)).toBe(false);
		expect(isActive(claim({ completedAt: '2026-08-16T10:00:00.000Z' }), NOW)).toBe(false);
		expect(isActive(claim({ expiresAt: '2026-08-16T11:59:59.000Z' }), NOW)).toBe(false);
	});

	// A corrupt timestamp must free the turf, not freeze it forever.
	it('treats an unparseable expiry as already lapsed', () => {
		expect(isActive(claim({ expiresAt: 'not-a-date' }), NOW)).toBe(false);
	});
});

describe('activeClaimFor', () => {
	it('finds the holder of one turf and ignores other turf', () => {
		const claims = [claim(), claim({ mapRouteId: 4102, slackUserId: 'U_BOB' })];
		expect(activeClaimFor(4101, claims, NOW)?.slackUserId).toBe('U_ALICE');
		expect(activeClaimFor(4102, claims, NOW)?.slackUserId).toBe('U_BOB');
	});

	it('returns null when every claim on that turf is finished', () => {
		expect(
			activeClaimFor(4101, [claim({ completedAt: '2026-08-16T10:00:00.000Z' })], NOW),
		).toBeNull();
	});

	it('prefers the most recent when several somehow overlap', () => {
		const claims = [
			claim({ slackUserId: 'U_OLD', claimedAt: '2026-08-15T09:00:00.000Z' }),
			claim({ slackUserId: 'U_NEW', claimedAt: '2026-08-16T09:00:00.000Z' }),
		];
		expect(activeClaimFor(4101, claims, NOW)?.slackUserId).toBe('U_NEW');
	});
});

describe('turfStatus', () => {
	it('reports your own claim as yours', () => {
		expect(turfStatus(turf(), [claim()], 'U_ALICE', NOW)).toBe('held-by-you');
	});

	it('reports someone else’s claim as held-by-other', () => {
		expect(turfStatus(turf(), [claim()], 'U_BOB', NOW)).toBe('held-by-other');
	});

	it('is available with no claims', () => {
		expect(turfStatus(turf(), [], 'U_BOB', NOW)).toBe('available');
	});

	it('reports VAN-side distribution when nobody holds it here', () => {
		expect(turfStatus(turf({ vanDistributedTo: 'Marcus T.' }), [], 'U_BOB', NOW)).toBe(
			'assigned-in-van',
		);
	});

	// Our ledger wins: telling a volunteer their own turf is "assigned in VAN"
	// would be both confusing and wrong.
	it('prefers our own ledger over VAN distribution', () => {
		expect(turfStatus(turf({ vanDistributedTo: 'Marcus T.' }), [claim()], 'U_ALICE', NOW)).toBe(
			'held-by-you',
		);
	});

	it('frees a turf whose claim lapsed', () => {
		const stale = claim({ expiresAt: '2026-08-16T11:00:00.000Z' });
		expect(turfStatus(turf(), [stale], 'U_BOB', NOW)).toBe('available');
	});
});

describe('canClaim', () => {
	it('allows an ordinary claim and returns the expiry', () => {
		const decision = canClaim(turf(), [], 'U_BOB', NOW);
		expect(decision.ok).toBe(true);
		if (decision.ok) expect(decision.expiresAt).toBe('2026-08-18T12:00:00.000Z');
	});

	it('refuses a retired turf', () => {
		const d = canClaim(turf({ retiredAt: '2026-08-15T00:00:00.000Z' }), [], 'U_BOB', NOW);
		expect(d).toMatchObject({ ok: false, reason: 'retired' });
	});

	// The one that would otherwise hand a volunteer a blank code.
	it('refuses a turf with no MiniVAN list number', () => {
		const d = canClaim(turf({ printedListNumber: null }), [], 'U_BOB', NOW);
		expect(d).toMatchObject({ ok: false, reason: 'no-list-number' });
	});

	it('refuses a turf with no doors left', () => {
		expect(canClaim(turf({ doorCount: 0 }), [], 'U_BOB', NOW)).toMatchObject({
			ok: false,
			reason: 'no-doors-left',
		});
	});

	it('refuses a turf someone else holds', () => {
		expect(canClaim(turf(), [claim()], 'U_BOB', NOW)).toMatchObject({
			ok: false,
			reason: 'already-held',
		});
	});

	it('tells you when the turf you are trying to claim is already yours', () => {
		const d = canClaim(turf(), [claim()], 'U_ALICE', NOW);
		expect(d).toMatchObject({ ok: false, reason: 'already-held' });
		if (!d.ok) expect(d.message).toContain('already got');
	});

	it('refuses turf distributed in VAN', () => {
		expect(canClaim(turf({ vanDistributedTo: 'Marcus T.' }), [], 'U_BOB', NOW)).toMatchObject({
			ok: false,
			reason: 'assigned-in-van',
		});
	});

	it('enforces the per-volunteer claim cap', () => {
		const held = [
			claim({ mapRouteId: 4200, slackUserId: 'U_BOB' }),
			claim({ mapRouteId: 4201, slackUserId: 'U_BOB' }),
		];
		expect(canClaim(turf(), held, 'U_BOB', NOW)).toMatchObject({
			ok: false,
			reason: 'at-claim-limit',
		});
	});

	it('does not count finished claims toward the cap', () => {
		const held = [
			claim({ mapRouteId: 4200, slackUserId: 'U_BOB', completedAt: '2026-08-16T10:00:00.000Z' }),
			claim({ mapRouteId: 4201, slackUserId: 'U_BOB', releasedAt: '2026-08-16T10:00:00.000Z' }),
		];
		expect(canClaim(turf(), held, 'U_BOB', NOW).ok).toBe(true);
	});

	it('honours a configured cap and TTL', () => {
		const held = [claim({ mapRouteId: 4200, slackUserId: 'U_BOB' })];
		expect(canClaim(turf(), held, 'U_BOB', NOW, { maxConcurrentClaims: 1 })).toMatchObject({
			ok: false,
			reason: 'at-claim-limit',
		});

		const d = canClaim(turf(), [], 'U_BOB', NOW, { ttlHours: 6 });
		if (d.ok) expect(d.expiresAt).toBe('2026-08-16T18:00:00.000Z');
	});

	// Ordering matters: a volunteer at their cap standing on unclaimable turf
	// should be told why the TURF is unavailable, not blamed for their cap.
	it('reports the turf problem before the claim limit', () => {
		const held = [
			claim({ mapRouteId: 4200, slackUserId: 'U_BOB' }),
			claim({ mapRouteId: 4201, slackUserId: 'U_BOB' }),
		];
		expect(
			canClaim(turf({ retiredAt: '2026-08-15T00:00:00.000Z' }), held, 'U_BOB', NOW),
		).toMatchObject({ reason: 'retired' });
	});

	it('gives every refusal a message fit to show a volunteer', () => {
		const cases = [
			canClaim(turf({ retiredAt: 'x' }), [], 'U_BOB', NOW),
			canClaim(turf({ printedListNumber: null }), [], 'U_BOB', NOW),
			canClaim(turf({ doorCount: 0 }), [], 'U_BOB', NOW),
			canClaim(turf(), [claim()], 'U_BOB', NOW),
		];
		for (const c of cases) {
			expect(c.ok).toBe(false);
			if (!c.ok) {
				expect(c.message.length).toBeGreaterThan(10);
				expect(c.message).not.toMatch(/error|null|undefined/i);
			}
		}
	});
});

describe('activeClaimsFor / lapsedClaims / hoursRemaining', () => {
	it('counts only a person’s live claims', () => {
		const claims = [
			claim({ slackUserId: 'U_BOB', mapRouteId: 1 }),
			claim({ slackUserId: 'U_BOB', mapRouteId: 2, releasedAt: '2026-08-16T10:00:00.000Z' }),
			claim({ slackUserId: 'U_ALICE', mapRouteId: 3 }),
		];
		expect(activeClaimsFor('U_BOB', claims, NOW)).toHaveLength(1);
	});

	it('finds claims needing a release stamp', () => {
		const claims = [
			claim({ mapRouteId: 1, expiresAt: '2026-08-16T11:00:00.000Z' }),
			claim({ mapRouteId: 2 }),
			claim({ mapRouteId: 3, expiresAt: '2026-08-16T11:00:00.000Z', releasedAt: 'done' }),
		];
		expect(lapsedClaims(claims, NOW).map((c) => c.mapRouteId)).toEqual([1]);
	});

	it('rounds remaining hours up and floors at zero', () => {
		expect(hoursRemaining(claim({ expiresAt: '2026-08-16T13:30:00.000Z' }), NOW)).toBe(2);
		expect(hoursRemaining(claim({ expiresAt: '2026-08-16T11:00:00.000Z' }), NOW)).toBe(0);
	});
});

describe('expiryFor', () => {
	it('defaults to 48 hours', () => {
		expect(expiryFor(NOW)).toBe('2026-08-18T12:00:00.000Z');
	});
});

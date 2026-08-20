import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('$lib/server/env', () => ({ SLACK_CLIENT_SECRET: 'client-secret' }));

import { signState, verifyState, STATE_TTL_MS } from './oauth-state.js';

/** Rebuild a state from a payload the caller has meddled with. */
function restate(state: string, edit: (payload: Record<string, unknown>) => void): string {
	const [encoded, signature] = state.split('.');
	const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	edit(payload);
	return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${signature}`;
}

describe('oauth state', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('round-trips the nonce, destination and retry flag', () => {
		const { state, nonce } = signState({ destination: '/members?user=U123', isRetry: true });
		const verdict = verifyState(state);

		expect(verdict).toMatchObject({
			ok: true,
			state: { nonce, destination: '/members?user=U123', isRetry: true },
		});
	});

	it('gives every attempt its own nonce', () => {
		const a = signState({ destination: null, isRetry: false });
		const b = signState({ destination: null, isRetry: false });

		expect(a.nonce).not.toBe(b.nonce);
		expect(a.state).not.toBe(b.state);
	});

	it('keeps the nonce out of plain sight of nothing — it is readable, just signed', () => {
		// The state is authenticated, not encrypted: the point is that it cannot be
		// *changed*, not that it cannot be read. Worth pinning so nobody later puts
		// a secret in here on the assumption it is hidden.
		const { state, nonce } = signState({ destination: null, isRetry: false });
		const [encoded] = state.split('.');

		expect(Buffer.from(encoded, 'base64url').toString('utf8')).toContain(nonce);
	});

	describe('rejects', () => {
		it('a rewritten destination', () => {
			const { state } = signState({ destination: '/', isRetry: false });
			const forged = restate(state, (p) => {
				p.d = '/settings';
			});

			expect(verifyState(forged)).toEqual({ ok: false, reason: 'bad-signature' });
		});

		it('a rewritten retry flag — otherwise the loop guard could be cleared', () => {
			const { state } = signState({ destination: null, isRetry: true });
			const forged = restate(state, (p) => {
				p.r = false;
			});

			expect(verifyState(forged)).toEqual({ ok: false, reason: 'bad-signature' });
		});

		it('a refreshed timestamp — otherwise the TTL could be extended at will', () => {
			const { state } = signState({ destination: null, isRetry: false });
			const forged = restate(state, (p) => {
				p.t = Date.now() + 60_000;
			});

			expect(verifyState(forged)).toEqual({ ok: false, reason: 'bad-signature' });
		});

		it('a signature of the right shape but the wrong value', () => {
			const { state } = signState({ destination: null, isRetry: false });
			const [encoded] = state.split('.');

			expect(verifyState(`${encoded}.${'A'.repeat(43)}`)).toEqual({
				ok: false,
				reason: 'bad-signature',
			});
		});
	});

	describe('reports as malformed rather than as tampering', () => {
		// This is what the previous implementation minted, and what the callback
		// keys its "restart, do not reject" behaviour off across a deploy.
		it('a bare UUID from the unsigned era', () => {
			expect(verifyState('550e8400-e29b-41d4-a716-446655440000')).toEqual({
				ok: false,
				reason: 'malformed',
			});
		});

		it.each([
			['', 'empty'],
			['.', 'a lone separator'],
			['a.b.c', 'too many parts'],
		])('%s (%s)', (raw) => {
			expect(verifyState(raw)).toEqual({ ok: false, reason: 'malformed' });
		});
	});

	describe('TTL', () => {
		it('accepts a state used just inside the window', () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			const { state } = signState({ destination: null, isRetry: false });
			vi.advanceTimersByTime(STATE_TTL_MS - 1000);

			expect(verifyState(state).ok).toBe(true);
		});

		it('expires a state used just outside it', () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			const { state } = signState({ destination: null, isRetry: false });
			vi.advanceTimersByTime(STATE_TTL_MS + 1000);

			expect(verifyState(state)).toEqual({ ok: false, reason: 'expired' });
		});
	});

	// The state travels as a query parameter on the URL handed to Slack, so an
	// unbounded destination would be an unbounded URL.
	it('drops a destination too long to ride in the state', () => {
		const { state } = signState({ destination: `/${'a'.repeat(300)}`, isRetry: false });
		const verdict = verifyState(state);

		expect(verdict.ok && verdict.state.destination).toBe(null);
		expect(state.length).toBeLessThan(256);
	});

	it('keeps a realistic destination well within URL limits', () => {
		const { state } = signState({ destination: '/members?user=U0123456789', isRetry: false });

		expect(state.length).toBeLessThan(256);
	});
});

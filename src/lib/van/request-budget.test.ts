import { describe, it, expect } from 'vitest';
import {
	recordRequest,
	pruneRequestLog,
	MAX_REQUESTS,
	REQUEST_WINDOW_MS,
	type RequestLog,
} from './request-budget.js';

const T0 = 1_700_000_000_000;

describe('recordRequest', () => {
	it('allows requests up to the budget', () => {
		const log: RequestLog = new Map();
		for (let i = 0; i < MAX_REQUESTS; i++) {
			expect(recordRequest(log, 'U1', T0 + i).allowed).toBe(true);
		}
	});

	it('refuses the next one', () => {
		const log: RequestLog = new Map();
		for (let i = 0; i < MAX_REQUESTS; i++) recordRequest(log, 'U1', T0);
		const decision = recordRequest(log, 'U1', T0);
		expect(decision.allowed).toBe(false);
		expect(decision.retryAfterSeconds).toBeGreaterThan(0);
	});

	// A client that keeps retrying must not push its own window forward
	// forever — that turns a momentary burst into a permanent lockout.
	it('does not let refused requests extend the lockout', () => {
		const log: RequestLog = new Map();
		for (let i = 0; i < MAX_REQUESTS; i++) recordRequest(log, 'U1', T0);
		for (let i = 0; i < 500; i++) recordRequest(log, 'U1', T0 + i);
		expect(recordRequest(log, 'U1', T0 + REQUEST_WINDOW_MS + 1).allowed).toBe(true);
	});

	it('lets the window roll off', () => {
		const log: RequestLog = new Map();
		for (let i = 0; i < MAX_REQUESTS; i++) recordRequest(log, 'U1', T0);
		expect(recordRequest(log, 'U1', T0).allowed).toBe(false);
		expect(recordRequest(log, 'U1', T0 + REQUEST_WINDOW_MS + 1).allowed).toBe(true);
	});

	it('counts each user separately', () => {
		const log: RequestLog = new Map();
		for (let i = 0; i < MAX_REQUESTS; i++) recordRequest(log, 'U1', T0);
		expect(recordRequest(log, 'U1', T0).allowed).toBe(false);
		expect(recordRequest(log, 'U2', T0).allowed).toBe(true);
	});

	// The whole point: a person panning a map is nowhere near the limit, and a
	// script walking a bbox grid is well past it.
	it('leaves a realistic panning session far inside the budget', () => {
		const log: RequestLog = new Map();
		// The map debounces to 250ms and only fires on a settled view; four
		// requests a second for ten seconds is a very hard drag.
		let allowed = 0;
		for (let i = 0; i < 40; i++) {
			if (recordRequest(log, 'U1', T0 + i * 250).allowed) allowed++;
		}
		expect(allowed).toBe(40);
	});
});

describe('pruneRequestLog', () => {
	it('drops users whose requests have aged out', () => {
		const log: RequestLog = new Map();
		recordRequest(log, 'U1', T0);
		pruneRequestLog(log, T0 + REQUEST_WINDOW_MS + 1);
		expect(log.size).toBe(0);
	});

	it('keeps users with recent requests', () => {
		const log: RequestLog = new Map();
		recordRequest(log, 'U1', T0);
		pruneRequestLog(log, T0 + 1000);
		expect(log.get('U1')).toHaveLength(1);
	});
});

// Admins are exempt — the budget makes bulk enumeration slow for ordinary
// members, and an admin can already read every chapter through the organizer
// and drift pages.
describe('admin exemption', () => {
	function spend(log: RequestLog, user: string, count: number, now: number) {
		for (let i = 0; i < count; i++) recordRequest(log, user, now);
	}

	it('refuses a volunteer past the budget', () => {
		const log: RequestLog = new Map();
		spend(log, 'U1', MAX_REQUESTS, T0);
		expect(recordRequest(log, 'U1', T0).allowed).toBe(false);
	});

	it('never refuses an exempt caller', () => {
		const log: RequestLog = new Map();
		spend(log, 'U1', MAX_REQUESTS, T0);
		for (let i = 0; i < 50; i++) {
			expect(recordRequest(log, 'U1', T0, { exempt: true }).allowed).toBe(true);
		}
	});

	// Still recorded, so `used` stays truthful and the log keeps its value.
	it("still counts an exempt caller's requests", () => {
		const log: RequestLog = new Map();
		spend(log, 'U1', MAX_REQUESTS, T0);
		const decision = recordRequest(log, 'U1', T0, { exempt: true });
		expect(decision.used).toBe(MAX_REQUESTS + 1);
		expect(decision.retryAfterSeconds).toBe(0);
	});

	// The exemption is per-call, not sticky: one admin request must not raise
	// the ceiling for a volunteer sharing the store.
	it('does not exempt a different user', () => {
		const log: RequestLog = new Map();
		spend(log, 'U1', MAX_REQUESTS, T0);
		recordRequest(log, 'U1', T0, { exempt: true });
		spend(log, 'U2', MAX_REQUESTS, T0);
		expect(recordRequest(log, 'U2', T0).allowed).toBe(false);
	});
});

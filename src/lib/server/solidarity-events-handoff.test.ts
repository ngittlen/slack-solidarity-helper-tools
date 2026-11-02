import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SolidarityEvent } from '../../../mobilize-migrator/lib/solidarity.js';
import {
	fresh,
	HANDOFF_MAX_AGE_MS,
	handSolidarityEvents,
	takeSolidarityEvents,
} from './solidarity-events-handoff.js';

const events = (id: number) => [{ id }] as unknown as SolidarityEvent[];

afterEach(() => {
	takeSolidarityEvents();
	vi.useRealTimers();
});

describe('the Solidarity events handoff', () => {
	it('hands the read on once', () => {
		handSolidarityEvents(events(1), 1000);
		expect(takeSolidarityEvents(1000 + HANDOFF_MAX_AGE_MS)).toEqual({
			at: 1000,
			events: events(1),
		});
		expect(takeSolidarityEvents(1000 + HANDOFF_MAX_AGE_MS)).toBeNull();
	});

	it('hands on nothing stale', () => {
		handSolidarityEvents(events(1), 1000);
		expect(takeSolidarityEvents(1001 + HANDOFF_MAX_AGE_MS)).toBeNull();
	});

	it('hands on the latest read', () => {
		handSolidarityEvents(events(1), 1000);
		handSolidarityEvents(events(2), 2000);
		expect(takeSolidarityEvents(2000)?.events).toEqual(events(2));
	});

	it('lets go of a read nobody takes', () => {
		vi.useFakeTimers();
		handSolidarityEvents(events(1));
		vi.advanceTimersByTime(HANDOFF_MAX_AGE_MS);
		expect(takeSolidarityEvents(0)).toBeNull();
	});
});

describe('fresh', () => {
	it('is the same age limit as taking', () => {
		expect(fresh({ at: 0 }, HANDOFF_MAX_AGE_MS)).toBe(true);
		expect(fresh({ at: 0 }, HANDOFF_MAX_AGE_MS + 1)).toBe(false);
	});
});

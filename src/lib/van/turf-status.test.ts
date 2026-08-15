import { describe, it, expect } from 'vitest';
import {
	statusLabel,
	visibleTurfState,
	volunteerStatus,
	type TurfStateSource,
	type TurfStatus,
} from './turf-status.js';

const VOLUNTEER = { isAdmin: false };
const ADMIN = { isAdmin: true };

const source = (over: Partial<TurfStateSource> = {}): TurfStateSource => ({
	status: 'held-by-other',
	heldBy: 'Priya R.',
	expiresInHours: 11,
	...over,
});

describe('volunteerStatus', () => {
	it('passes available and your own claim through', () => {
		expect(volunteerStatus('available')).toBe('available');
		expect(volunteerStatus('held-by-you')).toBe('held-by-you');
	});

	it('collapses both taken states to one', () => {
		expect(volunteerStatus('held-by-other')).toBe('checked-out');
		expect(volunteerStatus('assigned-in-van')).toBe('checked-out');
	});
});

describe('visibleTurfState — volunteers', () => {
	it('never reveals who holds a turf', () => {
		for (const status of ['held-by-other', 'assigned-in-van'] as TurfStatus[]) {
			expect(visibleTurfState(source({ status }), VOLUNTEER).heldBy).toBeNull();
		}
	});

	// The whole point of the collapse: a volunteer must not be able to tell an
	// app claim from an organizer's hand assignment by any visible field.
	it('makes the two taken states indistinguishable', () => {
		const claimed = visibleTurfState(
			source({ status: 'held-by-other', heldBy: 'Priya R.', expiresInHours: 11 }),
			VOLUNTEER,
		);
		const assigned = visibleTurfState(
			source({ status: 'assigned-in-van', heldBy: 'Marcus T.', expiresInHours: null }),
			VOLUNTEER,
		);
		expect(claimed).toEqual(assigned);
	});

	it('keeps the countdown on your own turf', () => {
		const mine = visibleTurfState(
			source({ status: 'held-by-you', heldBy: null, expiresInHours: 39 }),
			VOLUNTEER,
		);
		expect(mine.status).toBe('held-by-you');
		expect(mine.expiresInHours).toBe(39);
	});

	it('leaves an available turf alone', () => {
		expect(
			visibleTurfState(
				source({ status: 'available', heldBy: null, expiresInHours: null }),
				VOLUNTEER,
			),
		).toEqual({ status: 'available', heldBy: null, expiresInHours: null });
	});
});

describe('visibleTurfState — admins', () => {
	it('keeps the holder name', () => {
		expect(visibleTurfState(source(), ADMIN).heldBy).toBe('Priya R.');
	});

	it('keeps the expiry', () => {
		expect(visibleTurfState(source(), ADMIN).expiresInHours).toBe(11);
	});

	it('still collapses the status label, since that is a UI concern', () => {
		expect(visibleTurfState(source({ status: 'assigned-in-van' }), ADMIN).status).toBe(
			'checked-out',
		);
	});
});

describe('statusLabel', () => {
	it('gives one label to both taken states', () => {
		expect(statusLabel('checked-out')).toBe('Checked out');
		expect(statusLabel('available')).toBe('Available');
		expect(statusLabel('held-by-you')).toBe('Checked out by you');
	});
});

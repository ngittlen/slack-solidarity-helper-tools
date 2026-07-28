import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	runAttendeeSync,
	type AttendeeLedger,
	type RsvpRecord,
	type TimeslotLink,
} from './attendee-sync.js';
import type { MobilizeApiConfig, MobilizeAttendance } from './mobilize.js';

const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 44679 };

const LINK: TimeslotLink = {
	mobilizeTimeslotId: 6157028,
	mobilizeEventId: 812345,
	solidarityEventId: 27463,
	solidaritySessionId: 80929,
	eventChapterId: 1330,
	startsAt: Date.now() + 3600_000,
};

function attendance(overrides: Partial<MobilizeAttendance> = {}): MobilizeAttendance {
	return {
		id: 1,
		status: 'REGISTERED',
		attended: null,
		modified_date: 1785000000,
		event: { id: LINK.mobilizeEventId },
		timeslot: { id: LINK.mobilizeTimeslotId },
		person: {
			given_name: 'A',
			family_name: 'B',
			email_addresses: [{ primary: true, address: 'a@example.com' }],
			phone_numbers: [{ primary: true, number: '6165551234' }],
			postal_addresses: [{ primary: true, postal_code: '49504' }],
		},
		...overrides,
	};
}

/** Routes by URL: Mobilize v1 API, Solidarity RSVP list, Solidarity user search. */
function mockApis(options: { attendances: MobilizeAttendance[]; userFound?: boolean }) {
	const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url);
		const writing = init?.method === 'POST' || init?.method === 'PUT';
		let body: unknown = {};
		if (href.includes('api.mobilize.us')) {
			body = { data: options.attendances, next: null };
		} else if (writing) {
			// Solidarity returns the created row; the sync reads its id.
			body = { data: { id: 999 } };
		} else if (href.includes('/v1/event_rsvps')) {
			body = { data: [] };
		} else if (href.includes('/v1/users')) {
			body = { data: options.userFound ? [{ id: 999 }] : [] };
		}
		return {
			ok: true,
			status: 200,
			json: async () => body,
			text: async () => JSON.stringify(body),
			headers: new Headers(),
		} as unknown as Response;
	});
	vi.stubGlobal('fetch', spy);
	return spy;
}

function ledgerWith(records: RsvpRecord[] = []): AttendeeLedger {
	const map = new Map(records.map((r) => [r.mobilizeAttendanceId, r]));
	return {
		async rsvpsByAttendanceId() {
			return map;
		},
		async recordRsvp(record) {
			map.set(record.mobilizeAttendanceId, record);
		},
	};
}

function run(ledger: AttendeeLedger, apply = false, links: TimeslotLink[] = [LINK]) {
	return runAttendeeSync(
		links,
		{ api: API, solidarityToken: 't', apply, maxNewProfiles: 1000, pauseMs: 0 },
		ledger,
		new Map(),
		1330,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('runAttendeeSync dry-run accounting', () => {
	it('counts the RSVP for someone who would also need a new profile', async () => {
		// Regression: the dry run used to `continue` after counting the profile,
		// so it reported far fewer RSVPs than the real run would write — and that
		// number is what a human uses to decide whether to proceed.
		mockApis({ attendances: [attendance()], userFound: false });

		const report = await run(ledgerWith());

		expect(report.profilesCreated).toBe(1);
		expect(report.rsvpsCreated).toBe(1);
	});

	it('reconciles: every signup is matched, created, or explicitly skipped', async () => {
		mockApis({
			attendances: [
				attendance({ id: 1 }),
				attendance({ id: 2 }),
				attendance({ id: 3, person: { given_name: 'No', family_name: 'Contact' } }),
				attendance({ id: 4, status: 'SOMETHING_NEW' }),
			],
			userFound: false,
		});

		const report = await run(ledgerWith());

		expect(report.participations).toBe(4);
		expect(
			report.matchedByEmail +
				report.matchedByPhone +
				report.profilesCreated +
				report.skippedNoContact +
				report.skippedUnknownStatus,
		).toBe(4);
	});

	it('does not double-count a profile in apply mode', async () => {
		mockApis({ attendances: [attendance()], userFound: false });

		const report = await run(ledgerWith(), true);

		expect(report.profilesCreated).toBe(1);
	});
});

describe('runAttendeeSync event grouping', () => {
	it('reads each event once, however many of its shifts are in scope', async () => {
		// The whole point of moving off the per-timeslot dashboard route: an event
		// with several shifts used to cost one request per shift.
		const second: TimeslotLink = {
			...LINK,
			mobilizeTimeslotId: 6157029,
			solidaritySessionId: 80930,
		};
		const spy = mockApis({ attendances: [attendance()], userFound: true });

		const report = await run(ledgerWith(), false, [LINK, second]);

		const mobilizeCalls = spy.mock.calls.filter(([url]) => String(url).includes('api.mobilize.us'));
		expect(mobilizeCalls).toHaveLength(1);
		expect(report.events).toBe(1);
		expect(report.timeslots).toBe(2);
	});

	it('drops signups for shifts outside the requested window', async () => {
		// One request returns every shift on the event, including ones the caller's
		// window excluded. Those must not be filed.
		mockApis({
			attendances: [attendance({ id: 1 }), attendance({ id: 2, timeslot: { id: 999999 } })],
			userFound: true,
		});

		const report = await run(ledgerWith());

		expect(report.participations).toBe(1);
	});
});

describe('runAttendeeSync change detection', () => {
	const prior: RsvpRecord = {
		mobilizeAttendanceId: 1,
		solidarityRsvpId: 500,
		solidarityUserId: 999,
		solidaritySessionId: LINK.solidaritySessionId,
		status: 'REGISTERED',
		attended: false,
		modifiedDate: 1785000000,
	};

	it('skips a signup that has not changed', async () => {
		mockApis({ attendances: [attendance()], userFound: true });

		const report = await run(ledgerWith([prior]));

		expect(report.unchanged).toBe(1);
		expect(report.rsvpsCreated).toBe(0);
	});

	it('reprocesses a row Mobilize has touched since we last mirrored it', async () => {
		mockApis({ attendances: [attendance({ modified_date: 1785009999 })], userFound: true });

		const report = await run(ledgerWith([prior]));

		expect(report.unchanged).toBe(0);
	});

	it('skips a previously-recorded attendance instead of reprocessing it forever', async () => {
		// Regression: the skip checked only `!participation.attended`, so everyone
		// who showed up was re-matched on every run while the event stayed inside
		// the lookback window.
		mockApis({ attendances: [attendance({ attended: true })], userFound: true });

		const report = await run(ledgerWith([{ ...prior, attended: true }]));

		expect(report.unchanged).toBe(1);
	});

	it('still processes a newly-recorded attendance', async () => {
		mockApis({ attendances: [attendance({ attended: true })], userFound: true });

		const report = await run(ledgerWith([prior]));

		expect(report.unchanged).toBe(0);
	});

	it('processes a cancellation of an existing RSVP', async () => {
		mockApis({ attendances: [attendance({ status: 'CANCELLED' })], userFound: true });

		const report = await run(ledgerWith([prior]));

		expect(report.unchanged).toBe(0);
		expect(report.rsvpsUpdated).toBe(1);
	});
});

describe('runAttendeeSync rsvp payload', () => {
	it('files the RSVP against a real agent', async () => {
		// Regression: `agent_user_id: null` is rejected with
		// 422 {"errors":["Agent must exist"]}, so every create failed. A Mobilize
		// signup is self-service, so the agent is the attendee — the same thing
		// Solidarity records for its own web-form signups.
		const spy = mockApis({ attendances: [attendance()], userFound: true });

		await run(ledgerWith(), true);

		const create = spy.mock.calls.find(
			([url, init]) =>
				String(url).includes('/v1/event_rsvps') &&
				(init as RequestInit | undefined)?.method === 'POST',
		);
		expect(create).toBeDefined();
		const body = JSON.parse(String((create![1] as RequestInit).body));
		expect(body.agent_user_id).toBe(999);
		expect(body.user_id).toBe(999);
	});
});

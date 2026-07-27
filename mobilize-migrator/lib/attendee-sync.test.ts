import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	runAttendeeSync,
	type AttendeeLedger,
	type RsvpRecord,
	type TimeslotLink,
} from './attendee-sync.js';
import { PARTICIPATION_STATUS } from './attendees.js';
import type { MobilizeSession } from './session.js';

const SESSION: MobilizeSession = {
	orgSlug: 'testorg',
	cookie: 'sessionid=abc; csrftoken=def',
	csrfToken: 'def',
	userAgent: 'test',
};

const LINK: TimeslotLink = {
	mobilizeTimeslotId: 6157028,
	solidarityEventId: 27463,
	solidaritySessionId: 80929,
	eventChapterId: 1330,
	startsAt: Date.now() + 3600_000,
};

function participation(overrides: Record<string, unknown> = {}) {
	return {
		person: {},
		participation_data: {
			id: 1,
			timeslot_id: LINK.mobilizeTimeslotId,
			status: PARTICIPATION_STATUS.REGISTERED,
			first_name: 'A',
			last_name: 'B',
			email: 'a@example.com',
			phone: '6165551234',
			zipcode: '49504',
			volunteer_check_in: null,
			...overrides,
		},
	};
}

/** Routes by URL: Mobilize dashboard, Solidarity RSVP list, Solidarity user search. */
function mockApis(options: {
	participations: ReturnType<typeof participation>[];
	userFound?: boolean;
	tooMany?: boolean;
}) {
	const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url);
		const writing = init?.method === 'POST' || init?.method === 'PUT';
		let body: unknown = {};
		if (href.includes('mobilize.us')) {
			body = {
				data: {
					participations: options.participations,
					paging_info: { page: 1, per_page: 25, num_pages: 1, count: options.participations.length },
					too_many_participations: options.tooMany ?? false,
				},
			};
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

function run(ledger: AttendeeLedger, apply = false) {
	return runAttendeeSync(
		[LINK],
		{ session: SESSION, solidarityToken: 't', apply, maxNewProfiles: 1000, pauseMs: 0 },
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
		mockApis({ participations: [participation()], userFound: false });

		const report = await run(ledgerWith());

		expect(report.profilesCreated).toBe(1);
		expect(report.rsvpsCreated).toBe(1);
	});

	it('reconciles: every signup is matched, created, or explicitly skipped', async () => {
		mockApis({
			participations: [
				participation({ id: 1 }),
				participation({ id: 2 }),
				participation({ id: 3, email: null, phone: null }),
				participation({ id: 4, status: 99 }),
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
		mockApis({ participations: [participation()], userFound: false });

		const report = await run(ledgerWith(), true);

		expect(report.profilesCreated).toBe(1);
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
	};

	it('skips a signup that has not changed', async () => {
		mockApis({ participations: [participation()], userFound: true });

		const report = await run(ledgerWith([prior]));

		expect(report.unchanged).toBe(1);
		expect(report.rsvpsCreated).toBe(0);
	});

	it('skips a previously-recorded attendance instead of reprocessing it forever', async () => {
		// Regression: the skip checked only `!participation.attended`, so everyone
		// who showed up was re-matched on every run while the event stayed inside
		// the lookback window.
		mockApis({
			participations: [participation({ volunteer_check_in: '2026-08-01T20:05:00Z' })],
			userFound: true,
		});

		const report = await run(ledgerWith([{ ...prior, attended: true }]));

		expect(report.unchanged).toBe(1);
	});

	it('still processes a newly-recorded attendance', async () => {
		mockApis({
			participations: [participation({ volunteer_check_in: '2026-08-01T20:05:00Z' })],
			userFound: true,
		});

		const report = await run(ledgerWith([prior]));

		expect(report.unchanged).toBe(0);
	});

	it('processes a cancellation of an existing RSVP', async () => {
		mockApis({
			participations: [participation({ status: PARTICIPATION_STATUS.CANCELLED })],
			userFound: true,
		});

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
		const spy = mockApis({ participations: [participation()], userFound: true });

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

describe('runAttendeeSync truncation', () => {
	it('reports a signup list Mobilize refused to fully enumerate', async () => {
		// Silently dropping attendees is worst on the busiest events, which is
		// exactly where an accurate list matters.
		mockApis({ participations: [participation()], userFound: true, tooMany: true });

		const report = await run(ledgerWith());

		expect(report.truncatedTimeslots).toBe(1);
		expect(report.errors.join(' ')).toMatch(/incomplete/);
	});
});

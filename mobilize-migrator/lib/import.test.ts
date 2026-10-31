import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	MAX_PERMANENT_FAILURES,
	runImport,
	type ImportLedger,
	type ImportRecord,
	type ImportStatus,
} from './import.js';
import type { PlannedImport } from './import-transform.js';

/** In-memory stand-in for TursoImportLedger. */
class MemoryLedger implements ImportLedger {
	events = new Map<
		number,
		{
			solidarityEventId: number | null;
			status: ImportStatus;
			title: string;
			pageUrl?: string | null;
			failedAttempts: number;
			stalledReportedAt: string | null;
		}
	>();
	timeslots = new Map<number, { mobilizeEventId: number; solidaritySessionId: number | null }>();

	async all(): Promise<ImportRecord[]> {
		return [...this.events].map(([mobilizeEventId, e]) => ({
			mobilizeEventId,
			solidarityEventId: e.solidarityEventId,
			status: e.status,
			title: e.title,
			failedAttempts: e.failedAttempts,
			stalledReportedAt: e.stalledReportedAt,
			importedTimeslotIds: new Set(
				[...this.timeslots]
					.filter(([, t]) => t.mobilizeEventId === mobilizeEventId)
					.map(([id]) => id),
			),
		}));
	}
	async recordEvent(entry: {
		mobilizeEventId: number;
		solidarityEventId: number | null;
		status: ImportStatus;
		title: string;
	}) {
		const prior = this.events.get(entry.mobilizeEventId);
		this.events.set(entry.mobilizeEventId, {
			...entry,
			failedAttempts: 0,
			stalledReportedAt: prior?.stalledReportedAt ?? null,
		});
	}
	async recordTimeslot(entry: {
		mobilizeTimeslotId: number;
		mobilizeEventId: number;
		solidaritySessionId: number | null;
	}) {
		this.timeslots.set(entry.mobilizeTimeslotId, entry);
	}
	async markComplete(mobilizeEventId: number, pageUrl: string | null) {
		const row = this.events.get(mobilizeEventId)!;
		row.status = 'complete';
		row.pageUrl = pageUrl;
	}
	async recordFailure(entry: { mobilizeEventId: number; title: string }) {
		const row = this.events.get(entry.mobilizeEventId);
		if (row) return ++row.failedAttempts;
		this.events.set(entry.mobilizeEventId, {
			solidarityEventId: null,
			status: 'failing',
			title: entry.title,
			failedAttempts: 1,
			stalledReportedAt: null,
		});
		return 1;
	}
	async setStatus(mobilizeEventId: number, status: ImportStatus) {
		this.events.get(mobilizeEventId)!.status = status;
	}
	async markStalledReported(ids: number[]) {
		for (const id of ids) this.events.get(id)!.stalledReportedAt = 'now';
	}
}

function plan(id: number, slotIds: number[] = [id * 10, id * 10 + 1]): PlannedImport {
	return {
		mobilizeEventId: id,
		title: `Event ${id}`,
		browserUrl: `https://m.us/e/${id}`,
		event: {
			title: `Event ${id}`,
			event_type: 'in_person',
			start_time: 1000,
			end_time: 2000,
			scope_id: 7,
			scope_type: 'Chapter',
			location_name: 'Hall',
			location_address: '1 Main St, Flint, MI 48502',
			tags: ['mobilize-exclude', 'mobilize-import'],
			allow_long_title: true,
		},
		timeslots: slotIds.map((s, i) => ({
			mobilizeTimeslotId: s,
			startTime: 1000 + i * 5000,
			endTime: 2000 + i * 5000,
		})),
		page: { content: '<p>Hi</p>', image_url: null },
		usedFallbackScope: false,
	};
}

interface Call {
	method: string;
	path: string;
	body: Record<string, unknown>;
}

/** A fake Solidarity: records every write and answers like the real one. */
function fakeSolidarity(
	overrides: (call: Call) => Response | undefined = () => undefined,
	existingPages: string[] = [],
): Call[] {
	const calls: Call[] = [];
	let nextEventId = 900;
	let nextSessionId = 5000;
	const pages = new Set<string>(existingPages);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			const call = {
				method: init.method ?? 'GET',
				path: url.replace('https://api.solidarity.tech/v1', ''),
				body: JSON.parse((init.body as string) ?? '{}'),
			};
			calls.push(call);
			const override = overrides(call);
			if (override) return override;
			if (call.path === '/events') {
				const id = nextEventId++;
				return Response.json({ data: { id, event_sessions: [{ id: nextSessionId++ }] } });
			}
			if (call.path === '/event_sessions') {
				return Response.json({ data: { id: nextSessionId++ } });
			}
			const page = /^\/events\/(\d+)\/page$/.exec(call.path);
			// Like the real endpoint: a second create for the same event is a 409.
			if (page && pages.has(page[1])) {
				return Response.json({ data: { id: Number(page[1]) } }, { status: 409 });
			}
			if (page) {
				pages.add(page[1]);
				return Response.json(
					{
						data: { id: Number(page[1]), event_page_id: 1, event_page_url: `https://p/${page[1]}` },
					},
					{ status: 201 },
				);
			}
			return new Response('not found', { status: 404 });
		}),
	);
	return calls;
}

const config = { solidarityToken: 't', maxCreatesPerRun: 10, apply: true };

beforeEach(() => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('runImport', () => {
	it('creates the event, its page, then its other sessions — and records each step', async () => {
		const calls = fakeSolidarity();
		const ledger = new MemoryLedger();
		const report = await runImport([plan(1)], config, ledger);

		expect(calls.map((c) => c.path)).toEqual(['/events', '/events/900/page', '/event_sessions']);
		expect(calls[2].body).toMatchObject({ event_id: 900, title: 'Event 1', start_time: 6000 });
		expect(report).toMatchObject({ created: 1, failed: 0, authFailed: false });
		expect(report.createdEvents).toEqual([
			{ title: 'Event 1', pageUrl: 'https://p/900', usedFallbackScope: false },
		]);
		expect(ledger.events.get(1)).toMatchObject({ solidarityEventId: 900, status: 'complete' });
		expect([...ledger.timeslots.keys()]).toEqual([10, 11]);
	});

	it('leaves complete imports alone — create-only', async () => {
		const calls = fakeSolidarity();
		const ledger = new MemoryLedger();
		await runImport([plan(1)], config, ledger);
		calls.length = 0;

		const report = await runImport([plan(1)], config, ledger);
		expect(calls).toEqual([]);
		expect(report.unchanged).toBe(1);
	});

	it('resumes an import a crashed run left half-done without re-creating the event', async () => {
		const ledger = new MemoryLedger();
		// The event and its first session exist; the second session and page don't.
		await ledger.recordEvent({
			mobilizeEventId: 1,
			solidarityEventId: 900,
			status: 'created',
			title: 'Event 1',
		});
		await ledger.recordTimeslot({
			mobilizeTimeslotId: 10,
			mobilizeEventId: 1,
			solidaritySessionId: null,
		});
		const calls = fakeSolidarity();

		const report = await runImport([plan(1)], config, ledger);
		expect(calls.map((c) => c.path)).toEqual(['/events/900/page', '/event_sessions']);
		expect(report).toMatchObject({ created: 0, resumed: 1 });
		expect(ledger.events.get(1)!.status).toBe('complete');
	});

	it('still creates the shifts when the page fails, and retries only the page', async () => {
		const first = fakeSolidarity((c) =>
			c.path.endsWith('/page') ? new Response('boom', { status: 500 }) : undefined,
		);
		const ledger = new MemoryLedger();
		const report = await runImport([plan(1)], config, ledger);
		expect(first.map((c) => c.path)).toEqual(['/events', '/events/900/page', '/event_sessions']);
		expect(report.failed).toBe(1);
		expect(report.errors[0]).toContain('"Event 1"');
		expect(ledger.events.get(1)!.status).toBe('created');
		expect([...ledger.timeslots.keys()]).toEqual([10, 11]);

		const retry = fakeSolidarity();
		const again = await runImport([plan(1)], config, ledger);
		expect(retry.map((c) => c.path)).toEqual(['/events/900/page']);
		expect(again.resumed).toBe(1);
		expect(ledger.events.get(1)!.status).toBe('complete');
	});

	it('keeps creating the other shifts when one is refused', async () => {
		let sessionCalls = 0;
		const calls = fakeSolidarity((c) =>
			c.path === '/event_sessions' && ++sessionCalls === 1
				? new Response('bad', { status: 422 })
				: undefined,
		);
		const ledger = new MemoryLedger();
		await runImport([plan(1, [10, 11, 12])], config, ledger);
		expect(calls.filter((c) => c.path === '/event_sessions')).toHaveLength(2);
		expect([...ledger.timeslots.keys()].sort()).toEqual([10, 12]);
		expect(ledger.events.get(1)).toMatchObject({ status: 'created', failedAttempts: 1 });
	});

	it('stops at the first ledger failure rather than creating shifts it cannot record', async () => {
		const calls = fakeSolidarity();
		const ledger = new MemoryLedger();
		const real = ledger.recordTimeslot.bind(ledger);
		ledger.recordTimeslot = async (entry) => {
			// The event's own first timeslot records fine; the next write fails.
			if (entry.mobilizeTimeslotId !== 10) throw new Error('database down');
			return real(entry);
		};
		const report = await runImport([plan(1, [10, 11, 12, 13])], config, ledger);
		expect(calls.filter((c) => c.path === '/event_sessions')).toHaveLength(1);
		expect(report.failed).toBe(1);
		expect(report.errors[0]).toContain('database down');
		expect(ledger.events.get(1)).toMatchObject({ status: 'created', failedAttempts: 0 });
	});

	it('stops at a network error, where it is unknown whether the shift was created', async () => {
		let sessionCalls = 0;
		const calls = fakeSolidarity((c) => {
			if (c.path === '/event_sessions' && ++sessionCalls === 1) {
				throw new TypeError('fetch failed');
			}
			return undefined;
		});
		const report = await runImport([plan(1, [10, 11, 12])], config, new MemoryLedger());
		expect(calls.filter((c) => c.path === '/event_sessions')).toHaveLength(1);
		expect(report.errors[0]).toContain('fetch failed');
	});

	it('counts the run towards giving up when a shift is refused, even if the page hit a 5xx', async () => {
		fakeSolidarity((c) => {
			if (c.path.endsWith('/page')) return new Response('down', { status: 503 });
			if (c.path === '/event_sessions') return new Response('bad', { status: 422 });
			return undefined;
		});
		const ledger = new MemoryLedger();
		await runImport([plan(1)], config, ledger);
		expect(ledger.events.get(1)).toMatchObject({ status: 'created', failedAttempts: 1 });
	});

	it('retries a page refused with its image once without the image', async () => {
		const withImage = {
			...plan(1),
			page: { content: '<p>Hi</p>', image_url: 'https://img/x.png' },
		};
		const calls = fakeSolidarity((c) =>
			c.path.endsWith('/page') && c.body.image_url
				? new Response('bad image', { status: 422 })
				: undefined,
		);
		const ledger = new MemoryLedger();
		const report = await runImport([withImage], config, ledger);
		const pageCalls = calls.filter((c) => c.path.endsWith('/page'));
		expect(pageCalls.map((c) => c.body.image_url)).toEqual(['https://img/x.png', null]);
		expect(report.failed).toBe(0);
		expect(ledger.events.get(1)!.status).toBe('complete');
	});

	it('does not retry a refused page that has no image', async () => {
		const calls = fakeSolidarity((c) =>
			c.path.endsWith('/page') ? new Response('bad', { status: 422 }) : undefined,
		);
		await runImport([plan(1)], config, new MemoryLedger());
		expect(calls.filter((c) => c.path.endsWith('/page'))).toHaveLength(1);
	});

	it('stops at once when the token is rejected while finishing an event', async () => {
		const calls = fakeSolidarity((c) =>
			c.path.endsWith('/page') ? new Response('nope', { status: 401 }) : undefined,
		);
		const report = await runImport([plan(1), plan(2)], config, new MemoryLedger());
		expect(report.authFailed).toBe(true);
		expect(calls.map((c) => c.path)).toEqual(['/events', '/events/900/page']);
	});

	it('treats a page that already exists as done', async () => {
		fakeSolidarity((c) =>
			c.path.endsWith('/page')
				? Response.json({ data: { id: 900, event_page_id: 3 } }, { status: 409 })
				: undefined,
		);
		const ledger = new MemoryLedger();
		const report = await runImport([plan(1)], config, ledger);
		expect(report.failed).toBe(0);
		expect(ledger.events.get(1)!.status).toBe('complete');
	});

	it('records a duplicate refusal once and never retries it', async () => {
		fakeSolidarity((c) =>
			c.path === '/events' ? new Response('duplicate', { status: 409 }) : undefined,
		);
		const ledger = new MemoryLedger();
		const report = await runImport([plan(1)], config, ledger);
		expect(report.duplicates).toEqual(['Event 1']);
		expect(report.failed).toBe(0);
		expect(ledger.events.get(1)).toMatchObject({ status: 'duplicate', solidarityEventId: null });

		const calls = fakeSolidarity();
		const again = await runImport([plan(1)], config, ledger);
		expect(calls).toEqual([]);
		expect(again.duplicates).toEqual([]);
	});

	it('creates no session for the first timeslot when the create response omits its id', async () => {
		const calls = fakeSolidarity((c) =>
			c.path === '/events' ? Response.json({ data: { id: 900 } }) : undefined,
		);
		const ledger = new MemoryLedger();
		await runImport([plan(1)], config, ledger);
		expect(calls.filter((c) => c.path === '/event_sessions')).toHaveLength(1);
		expect(ledger.timeslots.get(10)).toMatchObject({ solidaritySessionId: null });
	});

	it('creates nothing when the plan exceeds the create limit', async () => {
		const calls = fakeSolidarity();
		const report = await runImport(
			[plan(1), plan(2), plan(3)],
			{ ...config, maxCreatesPerRun: 2 },
			new MemoryLedger(),
		);
		expect(report.abortedReason).toMatch(/3 new events/);
		expect(calls).toEqual([]);
	});

	it('still finishes earlier imports when the create limit holds new ones back', async () => {
		const ledger = new MemoryLedger();
		await ledger.recordEvent({
			mobilizeEventId: 1,
			solidarityEventId: 900,
			status: 'created',
			title: 'Event 1',
		});
		await ledger.recordTimeslot({
			mobilizeTimeslotId: 10,
			mobilizeEventId: 1,
			solidaritySessionId: 1,
		});
		const calls = fakeSolidarity();
		const report = await runImport(
			[plan(1), plan(2), plan(3)],
			{ ...config, maxCreatesPerRun: 1 },
			ledger,
		);
		expect(report.abortedReason).toMatch(/2 new events/);
		expect(report.resumed).toBe(1);
		expect(calls.map((c) => c.path)).toEqual(['/events/900/page', '/event_sessions']);
	});

	it('writes nothing on a dry run and says what it would create and finish', async () => {
		const calls = fakeSolidarity();
		const ledger = new MemoryLedger();
		await ledger.recordEvent({
			mobilizeEventId: 3,
			solidarityEventId: 903,
			status: 'created',
			title: 'Event 3',
		});
		const fallback = { ...plan(2), usedFallbackScope: true };
		const report = await runImport(
			[plan(1), fallback, plan(3)],
			{ ...config, apply: false },
			ledger,
		);
		expect(calls).toEqual([]);
		expect(report.wouldCreate).toEqual(['Event 1', 'Event 2']);
		expect(report.wouldResume).toEqual(['Event 3']);
		expect(report.resumed).toBe(0);
		expect(report.fallbackScope).toEqual(['Event 2']);
	});

	it('records a create Solidarity accepted without an id, and never retries it', async () => {
		fakeSolidarity((c) => (c.path === '/events' ? new Response('', { status: 201 }) : undefined));
		const ledger = new MemoryLedger();
		const report = await runImport([plan(1)], config, ledger);
		expect(report.unconfirmed).toEqual(['Event 1']);
		expect(report.failed).toBe(0);
		expect(ledger.events.get(1)).toMatchObject({ status: 'unconfirmed', solidarityEventId: null });

		const calls = fakeSolidarity();
		await runImport([plan(1)], config, ledger);
		expect(calls).toEqual([]);
	});

	it('gives up on an event after repeated permanent refusals, and then leaves it alone', async () => {
		const ledger = new MemoryLedger();
		const refuse = () =>
			fakeSolidarity((c) =>
				c.path === '/events' ? new Response('{"errors":["bad"]}', { status: 422 }) : undefined,
			);
		for (let run = 1; run < MAX_PERMANENT_FAILURES; run++) {
			refuse();
			const report = await runImport([plan(1)], config, ledger);
			expect(report.failed).toBe(1);
			expect(report.rejected).toEqual([]);
			expect(ledger.events.get(1)).toMatchObject({ status: 'failing', failedAttempts: run });
		}
		refuse();
		const last = await runImport([plan(1)], config, ledger);
		expect(last.rejected).toEqual([{ title: 'Event 1', solidarityEventId: null }]);
		expect(ledger.events.get(1)!.status).toBe('rejected');

		const calls = fakeSolidarity();
		const after = await runImport([plan(1)], config, ledger);
		expect(calls).toEqual([]);
		expect(after.unchanged).toBe(1);
	});

	it('does not count a transient failure towards giving up', async () => {
		fakeSolidarity((c) =>
			c.path === '/events' ? new Response('down', { status: 503 }) : undefined,
		);
		const ledger = new MemoryLedger();
		const report = await runImport([plan(1)], config, ledger);
		expect(report.failed).toBe(1);
		expect(ledger.events.has(1)).toBe(false);
	});

	it('counts refusals while finishing an import, keeping it resumable until it gives up', async () => {
		const ledger = new MemoryLedger();
		fakeSolidarity((c) =>
			c.path.endsWith('/page') ? new Response('bad', { status: 422 }) : undefined,
		);
		await runImport([plan(1)], config, ledger);
		expect(ledger.events.get(1)).toMatchObject({ status: 'created', failedAttempts: 1 });
	});

	it('reports a half-finished import whose event left the plan, once', async () => {
		const ledger = new MemoryLedger();
		await ledger.recordEvent({
			mobilizeEventId: 1,
			solidarityEventId: 900,
			status: 'created',
			title: 'Event 1',
		});
		fakeSolidarity();
		const first = await runImport([], config, ledger);
		expect(first.stalled).toEqual(['Event 1']);
		expect(first.newlyStalled).toEqual(['Event 1']);

		const second = await runImport([], config, ledger);
		expect(second.stalled).toEqual(['Event 1']);
		expect(second.newlyStalled).toEqual([]);
	});

	it('does not mark stalled imports as reported on a dry run', async () => {
		const ledger = new MemoryLedger();
		await ledger.recordEvent({
			mobilizeEventId: 1,
			solidarityEventId: 900,
			status: 'created',
			title: 'Event 1',
		});
		await runImport([], { ...config, apply: false }, ledger);
		expect(ledger.events.get(1)!.stalledReportedAt).toBeNull();
	});

	it('stops between an event’s sessions when time runs out, and resumes next run', async () => {
		const ledger = new MemoryLedger();
		let now = 1_000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		fakeSolidarity((c) => {
			// The event create uses up the budget.
			if (c.path === '/events') now = 5_000;
			return undefined;
		});
		const report = await runImport(
			[plan(1, [10, 11, 12])],
			{ ...config, writeDeadline: 2_000 },
			ledger,
		);
		expect(report).toMatchObject({ created: 1, incomplete: true, pending: 1, failed: 0 });
		expect(ledger.events.get(1)!.status).toBe('created');

		now = 1_000;
		const calls = fakeSolidarity();
		const next = await runImport([plan(1, [10, 11, 12])], config, ledger);
		expect(calls.map((c) => c.path)).toEqual([
			'/events/900/page',
			'/event_sessions',
			'/event_sessions',
		]);
		expect(next.resumed).toBe(1);
	});

	it('stops at the first auth failure', async () => {
		const calls = fakeSolidarity(() => new Response('nope', { status: 401 }));
		const report = await runImport([plan(1), plan(2)], config, new MemoryLedger());
		expect(report.authFailed).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it('stops starting writes at the deadline and reports what is left', async () => {
		const calls = fakeSolidarity();
		const report = await runImport(
			[plan(1), plan(2)],
			{ ...config, writeDeadline: Date.now() - 1 },
			new MemoryLedger(),
		);
		expect(calls).toEqual([]);
		expect(report).toMatchObject({ incomplete: true, pending: 2 });
	});

	it('records a session Solidarity accepted without an id, and never creates it again', async () => {
		fakeSolidarity((c) =>
			c.path === '/event_sessions' ? new Response('', { status: 201 }) : undefined,
		);
		const ledger = new MemoryLedger();
		const report = await runImport([plan(1)], config, ledger);
		expect(report.failed).toBe(0);
		expect(ledger.timeslots.get(11)).toMatchObject({ solidaritySessionId: null });
		expect(ledger.events.get(1)!.status).toBe('complete');
	});

	it('counts a 409 on a session as a permanent refusal', async () => {
		fakeSolidarity((c) =>
			c.path === '/event_sessions' ? new Response('dup', { status: 409 }) : undefined,
		);
		const ledger = new MemoryLedger();
		await runImport([plan(1)], config, ledger);
		expect(ledger.events.get(1)).toMatchObject({ status: 'created', failedAttempts: 1 });
	});

	it('gives the event its page even when a shift is refused, and says it exists when giving up', async () => {
		const ledger = new MemoryLedger();
		const pages: string[] = [];
		const refuseShift = () =>
			fakeSolidarity(
				(c) =>
					c.path === '/event_sessions'
						? new Response('{"errors":["bad shift"]}', { status: 422 })
						: undefined,
				pages,
			);
		const calls = refuseShift();
		await runImport([plan(1)], config, ledger);
		expect(calls.map((c) => c.path)).toEqual(['/events', '/events/900/page', '/event_sessions']);
		pages.push('900');

		let last;
		for (let run = 2; run <= MAX_PERMANENT_FAILURES; run++) {
			refuseShift();
			last = await runImport([plan(1)], config, ledger);
		}
		expect(last!.rejected).toEqual([{ title: 'Event 1', solidarityEventId: 900 }]);
		expect(ledger.events.get(1)).toMatchObject({ status: 'rejected', solidarityEventId: 900 });
	});

	it('lists a created event in the summary even when finishing it fails', async () => {
		fakeSolidarity((c) =>
			c.path.endsWith('/page') ? new Response('boom', { status: 500 }) : undefined,
		);
		const report = await runImport([plan(1)], config, new MemoryLedger());
		expect(report.created).toBe(1);
		expect(report.createdEvents).toEqual([
			{ title: 'Event 1', pageUrl: null, usedFallbackScope: false },
		]);
	});

	it('does not use up a stalled announcement when the run throws before it ends', async () => {
		const ledger = new MemoryLedger();
		await ledger.recordEvent({
			mobilizeEventId: 2,
			solidarityEventId: 902,
			status: 'created',
			title: 'Stalled',
		});
		ledger.recordFailure = async () => {
			throw new Error('database down');
		};
		fakeSolidarity((c) =>
			c.path === '/events' ? new Response('bad', { status: 422 }) : undefined,
		);
		await expect(runImport([plan(1)], config, ledger)).rejects.toThrow('database down');
		expect(ledger.events.get(2)!.stalledReportedAt).toBeNull();
	});

	it('reports in-person events filed under the default chapter', async () => {
		fakeSolidarity();
		const report = await runImport(
			[{ ...plan(1), usedFallbackScope: true }],
			config,
			new MemoryLedger(),
		);
		expect(report.fallbackScope).toEqual(['Event 1']);
	});
});

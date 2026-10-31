// Partner-org Mobilize -> Solidarity event import: the write loop.
//
// Create-only. An event is imported once — event, its sessions, its page — and
// never edited afterwards, because Solidarity's API can't edit or delete an
// event anyway. What this DOES do is finish an import a previous run started:
// creating an event is three kinds of write, a run can die between them, and an
// event with no page or half its shifts is worse than one never imported.
//
// The ledger row is written the moment the event create succeeds, before any
// session or page. That ordering is the whole crash-safety story: a run that
// dies after the create resumes the event next time instead of creating it
// again, which is the one mistake here nobody can undo through the API.
//
// No $env and no database imports; the server passes the ledger in, like
// sync.ts.

import type { PlannedImport } from './import-transform.js';
import {
	createEvent,
	createEventPage,
	createEventSession,
	SolidarityCreateUnconfirmed,
	SolidarityWriteError,
} from './solidarity-events.js';

/**
 * - `failing`: the event create was refused, but not often enough to give up.
 *   No Solidarity event exists; the next run tries again.
 * - `created`: the event exists; sessions or page are still to finish.
 * - `complete`: done. Never touched again.
 * - `duplicate`: Solidarity refused the create as a duplicate. Not retried.
 * - `unconfirmed`: Solidarity said yes but returned no id, so the event very
 *   likely exists and cannot be finished. Not retried — that would make two.
 * - `rejected`: refused MAX_PERMANENT_FAILURES times (4xx). Not retried.
 */
export type ImportStatus =
	'failing' | 'created' | 'complete' | 'duplicate' | 'unconfirmed' | 'rejected';

/** Permanent refusals (4xx) before an event is given up on. A payload Solidarity
 *  rejects today it will reject next hour too; past this, retrying only repeats
 *  the same Slack alert. Not necessarily consecutive runs: transient failures
 *  (5xx, rate limits) neither count nor reset the tally. */
export const MAX_PERMANENT_FAILURES = 3;

export interface ImportRecord {
	mobilizeEventId: number;
	/** Null unless the event exists (`created` / `complete`). */
	solidarityEventId: number | null;
	status: ImportStatus;
	title: string;
	failedAttempts: number;
	/** When a stalled `created` import was last announced; null if never. */
	stalledReportedAt: string | null;
	/** Timeslots already turned into Solidarity sessions. */
	importedTimeslotIds: ReadonlySet<number>;
}

export interface ImportLedger {
	all(): Promise<ImportRecord[]>;
	/** Upsert; resets the failure count, since the event now has a new state. */
	recordEvent(entry: {
		mobilizeEventId: number;
		solidarityEventId: number | null;
		status: ImportStatus;
		title: string;
	}): Promise<void>;
	/** `solidaritySessionId` is null when the event-create response didn't say
	 *  which session it made — the timeslot is still covered and must not be
	 *  created twice. */
	recordTimeslot(entry: {
		mobilizeTimeslotId: number;
		mobilizeEventId: number;
		solidaritySessionId: number | null;
	}): Promise<void>;
	markComplete(mobilizeEventId: number, pageUrl: string | null): Promise<void>;
	/** Count a permanent refusal and return the new total. A row that doesn't
	 *  exist yet is created as `failing`; an existing row keeps its status. */
	recordFailure(entry: { mobilizeEventId: number; title: string }): Promise<number>;
	setStatus(mobilizeEventId: number, status: ImportStatus): Promise<void>;
	markStalledReported(mobilizeEventIds: number[]): Promise<void>;
}

export interface ImportConfig {
	solidarityToken: string;
	/** Guardrail: more new events than this and the run creates none. */
	maxCreatesPerRun: number;
	apply: boolean;
	/** Epoch ms after which no new write starts. */
	writeDeadline?: number;
	log?: (message: string) => void;
}

export interface CreatedImport {
	title: string;
	pageUrl: string | null;
	usedFallbackScope: boolean;
}

export interface ImportReport {
	/** Tagged, owned, public, upcoming events seen this run. */
	planned: number;
	created: number;
	/** Earlier imports this run finished (missing sessions or page). */
	resumed: number;
	/** Already settled: complete, duplicate, unconfirmed or rejected. */
	unchanged: number;
	/** Imports Solidarity refused as duplicates of an existing event, this run. */
	duplicates: string[];
	/** Creates Solidarity accepted without returning an id, this run. Each needs
	 *  a person to find the event in Solidarity and give it a page. */
	unconfirmed: string[];
	/** Events given up on this run after repeated permanent refusals. A
	 *  non-null `solidarityEventId` means the event exists in Solidarity but was
	 *  left unfinished — it needs a person, not just a note. */
	rejected: { title: string; solidarityEventId: number | null }[];
	/** Half-finished imports whose event has left the plan (untagged, made
	 *  private, or out of upcoming shifts), so they can't be finished. */
	stalled: string[];
	/** Of `stalled`, the ones never announced before. */
	newlyStalled: string[];
	failed: number;
	errors: string[];
	createdEvents: CreatedImport[];
	/** In-person events planned (dry) or created under the default chapter. */
	fallbackScope: string[];
	/** Titles a dry run would create. */
	wouldCreate: string[];
	/** Titles a dry run would finish. */
	wouldResume: string[];
	abortedReason?: string;
	authFailed: boolean;
	/** The write deadline stopped the run; `pending` events were not reached. */
	incomplete: boolean;
	pending: number;
}

export function emptyImportReport(): ImportReport {
	return {
		planned: 0,
		created: 0,
		resumed: 0,
		unchanged: 0,
		duplicates: [],
		unconfirmed: [],
		rejected: [],
		stalled: [],
		newlyStalled: [],
		failed: 0,
		errors: [],
		createdEvents: [],
		fallbackScope: [],
		wouldCreate: [],
		wouldResume: [],
		authFailed: false,
		incomplete: false,
		pending: 0,
	};
}

/** Thrown between writes inside one event when the run's time is up. The
 *  event stays `created` and the next request picks it up. */
class DeadlineReached extends Error {}

function isAuthFailure(err: unknown): boolean {
	return err instanceof SolidarityWriteError && (err.status === 401 || err.status === 403);
}

/** A refusal that will repeat if retried: a 4xx other than auth (its own
 *  alert) and rate limiting (transient). A 409 on the event create never gets
 *  here — it is caught and recorded as `duplicate` first — so a 409 that does
 *  is a session refusal, and as permanent as any other. */
function isPermanentRefusal(err: unknown): boolean {
	return (
		err instanceof SolidarityWriteError &&
		err.status >= 400 &&
		err.status < 500 &&
		![401, 403, 429].includes(err.status)
	);
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function runImport(
	planned: PlannedImport[],
	config: ImportConfig,
	ledger: ImportLedger,
): Promise<ImportReport> {
	const log = config.log ?? (() => {});
	const report: ImportReport = { ...emptyImportReport(), planned: planned.length };

	const records = new Map((await ledger.all()).map((r) => [r.mobilizeEventId, r]));
	let toCreate: PlannedImport[] = [];
	const toResume: { plan: PlannedImport; record: ImportRecord }[] = [];
	for (const plan of planned) {
		const record = records.get(plan.mobilizeEventId);
		if (!record || record.status === 'failing') toCreate.push(plan);
		else if (record.status === 'created') toResume.push({ plan, record });
		else report.unchanged++;
	}

	const plannedIds = new Set(planned.map((p) => p.mobilizeEventId));
	const stalled = [...records.values()].filter(
		(r) => r.status === 'created' && !plannedIds.has(r.mobilizeEventId),
	);
	report.stalled = stalled.map((r) => r.title);
	const newlyStalled = stalled.filter((r) => r.stalledReportedAt === null);
	report.newlyStalled = newlyStalled.map((r) => r.title);

	// Only the creates are held back: finishing an import already started is
	// not what the guardrail guards against, and blocking it would leave
	// pageless events up for as long as the flood lasts.
	if (toCreate.length > config.maxCreatesPerRun) {
		report.abortedReason =
			`${toCreate.length} new events to import exceeds the limit of ` +
			`${config.maxCreatesPerRun} per run.`;
		toCreate = [];
	}

	if (!config.apply) {
		report.wouldCreate = toCreate.map((p) => p.title);
		report.wouldResume = toResume.map((r) => r.plan.title);
		report.fallbackScope = toCreate.filter((p) => p.usedFallbackScope).map((p) => p.title);
		return report;
	}

	const pastDeadline = () =>
		config.writeDeadline !== undefined && Date.now() > config.writeDeadline;

	/** Solidarity event ids by Mobilize event, for the events this run knows
	 *  exist — so a rejection can say whether it left an event behind. */
	const existing = new Map<number, number>(
		toResume.map(({ record }) => [record.mobilizeEventId, record.solidarityEventId!]),
	);

	/**
	 * Create the page. If Solidarity refuses it (422) while it carries an image,
	 * try once more without: partner images are outside our control, and a
	 * picture Solidarity won't take should cost the picture, not the page.
	 */
	const createPage = async (plan: PlannedImport, solidarityEventId: number) => {
		try {
			return await createEventPage(config.solidarityToken, solidarityEventId, plan.page);
		} catch (err) {
			const refused = err instanceof SolidarityWriteError && err.status === 422;
			if (!refused || !plan.page.image_url) throw err;
			log(`"${plan.title}": page refused with its image — retrying without it`);
			return createEventPage(config.solidarityToken, solidarityEventId, {
				...plan.page,
				image_url: null,
			});
		}
	};

	/**
	 * The page, then a session for every timeslot not yet imported. Returns the
	 * page URL, and marks the import complete only when every part succeeded.
	 *
	 * The parts are independent: a refused page doesn't stop the shifts, and a
	 * refused shift doesn't stop the page or the other shifts. Each refusal is
	 * held, the rest still attempted, and one re-thrown at the end, so the row
	 * stays `created` and the next run retries only what is missing. Running
	 * out of time, a rejected token, and any error that isn't a refusal stop at
	 * once instead (see `attempt`).
	 *
	 * A resume asks for the page again; Solidarity answers 409 when it already
	 * exists, which costs one request and needs no extra state.
	 */
	const finish = async (
		plan: PlannedImport,
		solidarityEventId: number,
		done: ReadonlySet<number>,
	): Promise<string | null> => {
		// Only a Solidarity REFUSAL is held while the other parts go ahead: the
		// API answered no, so nothing was written. Anything else stops at once —
		// a ledger write that failed after a session was created (carrying on
		// would create every remaining shift unrecorded, so the next run would
		// duplicate them all), or a network error that leaves unknown whether
		// the write happened.
		const refusals: SolidarityWriteError[] = [];
		const attempt = async (part: () => Promise<void>) => {
			try {
				await part();
			} catch (err) {
				if (!(err instanceof SolidarityWriteError) || isAuthFailure(err)) throw err;
				if (refusals.length > 0) log(`"${plan.title}": also refused — ${describe(err)}`);
				refusals.push(err);
			}
		};

		let pageUrl: string | null = null;
		if (pastDeadline()) throw new DeadlineReached();
		await attempt(async () => {
			const page = await createPage(plan, solidarityEventId);
			if (page.alreadyExisted) log(`"${plan.title}" already has a page — left as it is`);
			pageUrl = page.pageUrl;
		});
		for (const slot of plan.timeslots) {
			if (done.has(slot.mobilizeTimeslotId)) continue;
			if (pastDeadline()) throw new DeadlineReached();
			await attempt(async () => {
				const sessionId = await createEventSession(config.solidarityToken, {
					event_id: solidarityEventId,
					title: plan.title,
					start_time: slot.startTime,
					end_time: slot.endTime,
					event_type: plan.event.event_type,
					location_name: plan.event.location_name,
					location_address: plan.event.location_address,
					allow_long_title: true,
				});
				await ledger.recordTimeslot({
					mobilizeTimeslotId: slot.mobilizeTimeslotId,
					mobilizeEventId: plan.mobilizeEventId,
					solidaritySessionId: sessionId,
				});
			});
		}
		// A permanent refusal outranks a transient one, so a shift Solidarity
		// will never accept still counts towards giving up even in a run where
		// the page also hit a 5xx.
		if (refusals.length > 0) throw refusals.find(isPermanentRefusal) ?? refusals[0];
		await ledger.markComplete(plan.mobilizeEventId, pageUrl);
		return pageUrl;
	};

	const work: { plan: PlannedImport; run: () => Promise<void> }[] = [
		// Resumes first: they are events people may already be looking at.
		...toResume.map(({ plan, record }) => ({
			plan,
			run: async () => {
				await finish(plan, record.solidarityEventId!, record.importedTimeslotIds);
				report.resumed++;
				log(`finished "${plan.title}"`);
			},
		})),
		...toCreate.map((plan) => ({
			plan,
			run: async () => {
				let created;
				try {
					created = await createEvent(config.solidarityToken, plan.event);
				} catch (err) {
					if (err instanceof SolidarityWriteError && err.status === 409) {
						// Recorded so the same refusal isn't retried — and alerted — every hour.
						await ledger.recordEvent({
							mobilizeEventId: plan.mobilizeEventId,
							solidarityEventId: null,
							status: 'duplicate',
							title: plan.title,
						});
						report.duplicates.push(plan.title);
						return;
					}
					if (err instanceof SolidarityCreateUnconfirmed) {
						await ledger.recordEvent({
							mobilizeEventId: plan.mobilizeEventId,
							solidarityEventId: null,
							status: 'unconfirmed',
							title: plan.title,
						});
						report.unconfirmed.push(plan.title);
						log(`"${plan.title}": ${err.message} — recorded, not retried`);
						return;
					}
					throw err;
				}
				await ledger.recordEvent({
					mobilizeEventId: plan.mobilizeEventId,
					solidarityEventId: created.id,
					status: 'created',
					title: plan.title,
				});
				existing.set(plan.mobilizeEventId, created.id);
				const first = plan.timeslots[0];
				await ledger.recordTimeslot({
					mobilizeTimeslotId: first.mobilizeTimeslotId,
					mobilizeEventId: plan.mobilizeEventId,
					solidaritySessionId: created.firstSessionId,
				});
				report.created++;
				if (plan.usedFallbackScope) report.fallbackScope.push(plan.title);
				log(`created "${plan.title}" as Solidarity event ${created.id}`);

				// Listed now, so the summary names every event that exists even if
				// finishing it fails below; the link is filled in once there is one.
				const entry: CreatedImport = {
					title: plan.title,
					pageUrl: null,
					usedFallbackScope: plan.usedFallbackScope,
				};
				report.createdEvents.push(entry);
				entry.pageUrl = await finish(plan, created.id, new Set([first.mobilizeTimeslotId]));
			},
		})),
	];

	for (const [index, { plan, run }] of work.entries()) {
		if (pastDeadline()) {
			report.incomplete = true;
			report.pending = work.length - index;
			break;
		}
		try {
			await run();
		} catch (err) {
			if (err instanceof DeadlineReached) {
				report.incomplete = true;
				report.pending = work.length - index;
				break;
			}
			report.errors.push(`"${plan.title}": ${describe(err)}`);
			if (isAuthFailure(err)) {
				report.authFailed = true;
				break;
			}
			report.failed++;
			if (isPermanentRefusal(err)) {
				const attempts = await ledger.recordFailure({
					mobilizeEventId: plan.mobilizeEventId,
					title: plan.title,
				});
				if (attempts >= MAX_PERMANENT_FAILURES) {
					await ledger.setStatus(plan.mobilizeEventId, 'rejected');
					report.rejected.push({
						title: plan.title,
						solidarityEventId: existing.get(plan.mobilizeEventId) ?? null,
					});
				}
			}
		}
	}

	// Stamped only once the run has got this far, so a run that throws midway
	// — and so never posts its alerts — doesn't silently use up the one
	// announcement each stalled import gets.
	if (newlyStalled.length > 0) {
		await ledger.markStalledReported(newlyStalled.map((r) => r.mobilizeEventId));
	}

	return report;
}

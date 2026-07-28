// The nightly sync: create newly-added Solidarity events in Mobilize, and push
// edits to the ones already migrated.
//
// Pure of $env and node:fs so both the CLI script and the SvelteKit server
// endpoint can use it — state comes in through the `Ledger` interface, config
// through `SyncConfig`. Same dual-use pattern as src/lib/server/solidarity-paginate.ts.

import { copyImageToMobilize } from './image.js';
import {
	createEvent,
	getOrgEvent,
	listUpcomingOrgEvents,
	MobilizeError,
	updateEvent,
	type MobilizeApiConfig,
	type MobilizeEvent,
} from './mobilize.js';
import {
	buildEventPayload,
	CAMPAIGN_TIMEZONE,
	type EventContact,
	type Timeslot,
} from './payload.js';
import type { PlannedEvent } from './transform.js';

/** Timeslots are matched between systems by start time, within this slack. */
const START_MATCH_TOLERANCE_MS = 60_000;

export interface LedgerRecord {
	key: string;
	mobilizeEventId: number;
	title: string;
}

/** Persistence for what we've created. Backed by Turso on the server, by a
 *  JSON file for the CLI. */
export interface Ledger {
	all(): Promise<LedgerRecord[]>;
	record(entry: LedgerRecord): Promise<void>;
	/** Solidarity image URL -> Mobilize-hosted URL, so an image uploads once. */
	imageFor(sourceUrl: string): Promise<string | null>;
	recordImage(sourceUrl: string, mobilizeUrl: string): Promise<void>;
	/**
	 * Mobilize timeslot -> Solidarity session, consumed by the attendee sync.
	 * Optional so the file-backed CLI ledger doesn't have to implement it.
	 */
	recordTimeslots?(pairings: TimeslotPairing[]): Promise<void>;
}

export interface SyncConfig {
	api: MobilizeApiConfig;
	/** Required by the v1 API on every create and update. */
	contact: EventContact;
	/** Refuse to create more than this in one unattended run. */
	maxCreatesPerRun: number;
	/**
	 * Stop after creating this many. Distinct from maxCreatesPerRun, which is a
	 * safety threshold that aborts the whole run — this is a deliberate "just do
	 * a few" cap for trying things out.
	 */
	createLimit?: number;
	/** When false, plan and report but write nothing. */
	apply: boolean;
	/** Milliseconds between writes, to stay clear of Cloudflare rate limiting. */
	pauseMs?: number;
	log?: (message: string) => void;
}

export interface SyncReport {
	planned: number;
	created: number;
	updated: number;
	unchanged: number;
	skippedExisting: number;
	failed: number;
	/** Set when the run refused to act because the plan was suspiciously large. */
	abortedReason?: string;
	/** Mobilize answered 403 — the API key is rejected or lacks write access. */
	authFailed: boolean;
	createdTitles: string[];
	updatedTitles: string[];
	/** Per-event reasons for the skips, so a dry run can be reviewed by eye. */
	skippedDetails: { title: string; reason: string }[];
	errors: string[];
}

export interface PutTimeslot {
	id?: number;
	/** Unix seconds. */
	startDate: number;
	endDate: number;
	maxAttendees: number | null;
}

export interface TimeslotPairing {
	mobilizeTimeslotId: number;
	mobilizeEventId: number;
	solidarityEventId: number;
	solidaritySessionId: number;
}

export interface TimeslotPlan {
	timeslots: PutTimeslot[];
	/** Live shifts with no counterpart in Solidarity — kept, never deleted. */
	orphanCount: number;
	changed: boolean;
	/**
	 * Mobilize timeslot -> Solidarity session, for the rows we matched. The
	 * attendee sync needs this to file a signup against the right session, and
	 * here is the only place both ids are known at once.
	 */
	pairings: TimeslotPairing[];
}

/**
 * Build the timeslot array for a PUT.
 *
 * Mobilize matches timeslots by id: a slot sent without one is created, and an
 * UPCOMING slot that is simply absent is destroyed *along with its signups*. So
 * existing shifts are matched to the plan by start time and re-sent with their
 * ids, new Solidarity sessions are sent without an id, and upcoming shifts with
 * no counterpart (a cancelled session, say) are re-sent untouched rather than
 * dropped. Deleting a shift volunteers have signed up for is far worse than
 * leaving a stale one behind.
 *
 * Past shifts are the exception: the v1 endpoint does not modify them at all,
 * so re-sending them is at best noise and at worst rejected. They are left out
 * entirely, and `now` is a parameter so tests can pin the boundary.
 */
export function reconcileTimeslots(
	plan: PlannedEvent,
	live: MobilizeEvent,
	now = Date.now(),
): TimeslotPlan {
	const liveSlots = [...live.timeslots].sort((a, b) => a.start_date - b.start_date);
	const consumed = new Set<number>();
	const timeslots: PutTimeslot[] = [];
	const pairings: TimeslotPairing[] = [];
	let changed = false;

	plan.timeslots.forEach((slot, index) => {
		const startInstant = plan.startInstants[index];
		const match = liveSlots.find(
			(candidate) =>
				!consumed.has(candidate.id) &&
				Math.abs(candidate.start_date * 1000 - startInstant) <= START_MATCH_TOLERANCE_MS,
		);
		if (match) {
			consumed.add(match.id);
			// An end-time edit still counts as a change even though the start matched.
			if (Math.abs(match.end_date * 1000 - plan.endInstants[index]) > START_MATCH_TOLERANCE_MS) {
				changed = true;
			}
			timeslots.push({ id: match.id, ...slot });
			const solidaritySessionId = plan.solidaritySessionIds[index];
			if (solidaritySessionId !== undefined) {
				pairings.push({
					mobilizeTimeslotId: match.id,
					mobilizeEventId: live.id,
					solidarityEventId: plan.solidarityEventId,
					solidaritySessionId,
				});
			}
		} else {
			changed = true;
			timeslots.push({ ...slot });
		}
	});

	// Only upcoming orphans need preserving; past ones are immune to the PUT.
	const orphans = liveSlots.filter(
		(slot) => !consumed.has(slot.id) && slot.end_date * 1000 > now,
	);
	for (const orphan of orphans) {
		timeslots.push({
			id: orphan.id,
			startDate: orphan.start_date,
			endDate: orphan.end_date,
			maxAttendees: null,
		});
	}

	return { timeslots, orphanCount: orphans.length, changed, pairings };
}

/** Fields worth a PUT. Location is compared loosely — Mobilize normalizes it. */
export function describeChanges(
	plan: PlannedEvent,
	live: MobilizeEvent,
	wantsImage: boolean,
	timeslotsChanged: boolean,
): string[] {
	const changes: string[] = [];
	if (plan.title.trim() !== (live.title ?? '').trim()) changes.push('title');
	if (plan.description.trim() !== (live.description ?? '').trim()) changes.push('description');
	if (wantsImage && !live.featured_image_url) changes.push('image');
	if (timeslotsChanged) changes.push('timeslots');
	const liveCity = (live.location?.locality ?? '').trim().toLowerCase();
	if (liveCity && plan.city.trim().toLowerCase() !== liveCity) changes.push('location');
	return changes;
}

/**
 * The one place a PlannedEvent becomes a Mobilize create/update body. Exported
 * because the CLI scripts need the identical mapping — four near-copies of this
 * block had already drifted apart once.
 */
export function payloadForPlan(
	plan: PlannedEvent,
	contact: EventContact,
	imageUrl?: string,
	/** Overridden on update, where reconcileTimeslots owns timeslot identity. */
	timeslots: Timeslot[] = plan.timeslots,
) {
	return buildEventPayload({
		title: plan.title,
		description: plan.description,
		imageUrl,
		eventType: plan.eventType,
		timezone: CAMPAIGN_TIMEZONE,
		locationName: plan.locationName,
		addressLine1: plan.addressLine1,
		city: plan.city,
		state: plan.state,
		zipcode: plan.zipcode,
		country: plan.country,
		locationIsPrivate: plan.locationIsPrivate,
		contact,
		timeslots,
	});
}

/**
 * Run one sync pass.
 *
 * `planned` comes from planMigration(); `findDuplicate` is injected so the
 * caller controls duplicate policy without this module importing it.
 */
export async function runSync(
	planned: PlannedEvent[],
	config: SyncConfig,
	ledger: Ledger,
	findDuplicate: (plan: PlannedEvent, existing: MobilizeEvent[]) => unknown,
): Promise<SyncReport> {
	const log = config.log ?? (() => {});
	const pause = () => new Promise((r) => setTimeout(r, config.pauseMs ?? 1000));
	const report: SyncReport = {
		planned: planned.length,
		created: 0,
		updated: 0,
		unchanged: 0,
		skippedExisting: 0,
		failed: 0,
		authFailed: false,
		createdTitles: [],
		updatedTitles: [],
		skippedDetails: [],
		errors: [],
	};

	const existing = await listUpcomingOrgEvents(config.api);
	const known = new Map((await ledger.all()).map((entry) => [entry.key, entry]));

	const toCreate: PlannedEvent[] = [];
	const toSync: { plan: PlannedEvent; record: LedgerRecord }[] = [];

	// The bulk list already carries description, image and timeslots, so the
	// update pass can diff from it instead of fetching each event individually —
	// that was ~90 extra rate-limited requests a run.
	const existingById = new Map(existing.map((event) => [event.id, event]));

	for (const plan of planned) {
		const record = known.get(plan.key);
		if (record) {
			toSync.push({ plan, record });
		} else {
			const duplicate = findDuplicate(plan, existing) as
				| { mobilizeEventId: number; mobilizeTitle: string; reason: string }
				| null;
			if (duplicate) {
				// Created by hand in Mobilize; we don't own it, so leave it alone.
				report.skippedExisting++;
				report.skippedDetails.push({
					title: plan.title,
					reason: `looks like Mobilize #${duplicate.mobilizeEventId} "${duplicate.mobilizeTitle}" (${duplicate.reason})`,
				});
			} else {
				toCreate.push(plan);
			}
		}
	}

	// Guardrail: a sudden flood means dedup or the source data broke. Do nothing
	// rather than publish a pile of bad public events.
	if (toCreate.length > config.maxCreatesPerRun) {
		report.abortedReason =
			`plan wants to create ${toCreate.length} events, over the limit of ${config.maxCreatesPerRun} — ` +
			'refusing to create anything. Review, then re-run with a raised limit if it is legitimate.';
		log(report.abortedReason);
		return report;
	}

	const resolveImage = async (plan: PlannedEvent): Promise<string | undefined> => {
		if (!plan.sourceImageUrl) return undefined;
		const cached = await ledger.imageFor(plan.sourceImageUrl);
		if (cached) return cached;
		if (!config.apply) return undefined;
		const uploaded = await copyImageToMobilize(plan.sourceImageUrl, plan.title, config.api);
		await ledger.recordImage(plan.sourceImageUrl, uploaded.publicUrl);
		return uploaded.publicUrl;
	};

	for (const plan of toCreate) {
		if (config.createLimit !== undefined && report.created >= config.createLimit) break;
		if (!config.apply) {
			report.created++;
			report.createdTitles.push(plan.title);
			continue;
		}
		try {
			const imageUrl = await resolveImage(plan);
			const { id, event } = await createEvent(
				config.api,
				payloadForPlan(plan, config.contact, imageUrl),
			);
			await ledger.record({ key: plan.key, mobilizeEventId: id, title: plan.title });
			report.created++;
			report.createdTitles.push(plan.title);
			log(`created #${id} "${plan.title}"`);

			// Pair the timeslot ids, which only exist post-create — without this the
			// attendee sync couldn't file signups against a brand-new event until
			// the following night's pass. The create response already carries them,
			// so this normally costs no extra request.
			if (ledger.recordTimeslots) {
				const created = event ?? (await getOrgEvent(config.api, id));
				if (created) await ledger.recordTimeslots(reconcileTimeslots(plan, created).pairings);
			}
		} catch (err) {
			if (err instanceof MobilizeError && err.status === 403) {
				report.authFailed = true;
				report.errors.push('Mobilize rejected the API key (403) — check MOBILIZE_API_KEY');
				return report;
			}
			report.failed++;
			report.errors.push(`create "${plan.title}": ${err instanceof Error ? err.message : err}`);
		}
		await pause();
	}

	for (const { plan, record } of toSync) {
		try {
			// Prefer the bulk list; fall back to a direct read only for events it
			// doesn't cover (all timeslots already past, or not publicly listed).
			const live =
				existingById.get(record.mobilizeEventId) ??
				(await getOrgEvent(config.api, record.mobilizeEventId));
			if (!live) {
				// Deleted in Mobilize, or no longer public. Not ours to resurrect.
				report.unchanged++;
				continue;
			}

			const slotPlan = reconcileTimeslots(plan, live);
			// Recorded before the change check, so the pairing stays fresh even when
			// the event itself needs no edit — but still only when applying. A dry
			// run must write nothing, including to the ledger.
			if (config.apply && ledger.recordTimeslots) {
				await ledger.recordTimeslots(slotPlan.pairings);
			}
			const wantsImage = Boolean(plan.sourceImageUrl);
			const changes = describeChanges(plan, live, wantsImage, slotPlan.changed);
			if (changes.length === 0) {
				report.unchanged++;
				continue;
			}
			if (!config.apply) {
				report.updated++;
				report.updatedTitles.push(`${plan.title} (${changes.join(', ')})`);
				continue;
			}

			const imageUrl = live.featured_image_url ? undefined : await resolveImage(plan);
			// reconcileTimeslots owns timeslot identity, so its list — ids and all —
			// replaces the one payloadForPlan derived from the plan alone.
			const payload = payloadForPlan(plan, config.contact, imageUrl, slotPlan.timeslots);

			await updateEvent(config.api, record.mobilizeEventId, payload);
			report.updated++;
			report.updatedTitles.push(`${plan.title} (${changes.join(', ')})`);
			log(`updated #${record.mobilizeEventId} "${plan.title}" — ${changes.join(', ')}`);
		} catch (err) {
			if (err instanceof MobilizeError && err.status === 403) {
				report.authFailed = true;
				report.errors.push('Mobilize rejected the API key (403) — check MOBILIZE_API_KEY');
				return report;
			}
			report.failed++;
			report.errors.push(`update "${plan.title}": ${err instanceof Error ? err.message : err}`);
		}
		await pause();
	}

	return report;
}

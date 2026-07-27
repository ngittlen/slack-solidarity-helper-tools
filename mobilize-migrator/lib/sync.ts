// The nightly sync: create newly-added Solidarity events in Mobilize, and push
// edits to the ones already migrated.
//
// Pure of $env and node:fs so both the CLI script and the SvelteKit server
// endpoint can use it — state comes in through the `Ledger` interface, config
// through `SyncConfig`. Same dual-use pattern as src/lib/server/solidarity-paginate.ts.

import { copyImageToMobilize } from './image.js';
import {
	createEvent,
	getPublicEvent,
	listUpcomingPublicEvents,
	MobilizeError,
	updateEvent,
	type PublicEvent,
} from './mobilize.js';
import { buildEventPayload } from './payload.js';
import type { MobilizeSession } from './session.js';
import { CAMPAIGN_TIMEZONE, toNaiveLocal } from './time.js';
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
	session: MobilizeSession;
	mobilizeOrgId: number;
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
	sessionExpired: boolean;
	createdTitles: string[];
	updatedTitles: string[];
	/** Per-event reasons for the skips, so a dry run can be reviewed by eye. */
	skippedDetails: { title: string; reason: string }[];
	errors: string[];
}

export interface PutTimeslot {
	id?: number;
	startsAtNaive: string;
	endsAtNaive: string;
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
 * Mobilize matches timeslots by id: a slot sent without one is created, and a
 * slot that is simply absent is destroyed *along with its signups*. So existing
 * shifts are matched to the plan by start time and re-sent with their ids, new
 * Solidarity sessions are sent without an id, and — importantly — live shifts
 * with no counterpart (a cancelled session, or a past shift the planner already
 * filtered out) are re-sent untouched rather than dropped. Deleting a shift
 * volunteers have signed up for is far worse than leaving a stale one behind.
 */
export function reconcileTimeslots(plan: PlannedEvent, live: PublicEvent): TimeslotPlan {
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

	const orphans = liveSlots.filter((slot) => !consumed.has(slot.id));
	for (const orphan of orphans) {
		timeslots.push({
			id: orphan.id,
			startsAtNaive: toNaiveLocal(new Date(orphan.start_date * 1000).toISOString()),
			endsAtNaive: toNaiveLocal(new Date(orphan.end_date * 1000).toISOString()),
			maxAttendees: null,
		});
	}

	return { timeslots, orphanCount: orphans.length, changed, pairings };
}

/** Fields worth a PUT. Location is compared loosely — Mobilize normalizes it. */
export function describeChanges(
	plan: PlannedEvent,
	live: PublicEvent & { description?: string; featured_image_url?: string | null },
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
export function payloadForPlan(plan: PlannedEvent, imageUrl?: string) {
	return buildEventPayload({
		name: plan.title,
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
		lat: plan.lat,
		lon: plan.lon,
		locationIsPrivate: plan.locationIsPrivate,
		timeslots: plan.timeslots,
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
	findDuplicate: (plan: PlannedEvent, existing: PublicEvent[]) => unknown,
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
		sessionExpired: false,
		createdTitles: [],
		updatedTitles: [],
		skippedDetails: [],
		errors: [],
	};

	const existing = await listUpcomingPublicEvents(config.mobilizeOrgId);
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
		const uploaded = await copyImageToMobilize(plan.sourceImageUrl, plan.title, config.session);
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
			const { id } = await createEvent(payloadForPlan(plan, imageUrl), config.session);
			await ledger.record({ key: plan.key, mobilizeEventId: id, title: plan.title });
			report.created++;
			report.createdTitles.push(plan.title);
			log(`created #${id} "${plan.title}"`);

			// Read back for the timeslot ids, which only exist post-create. Without
			// this the attendee sync couldn't file signups against a brand-new
			// event until the following night's pass.
			if (ledger.recordTimeslots) {
				const created = await getPublicEvent(id);
				if (created) await ledger.recordTimeslots(reconcileTimeslots(plan, created).pairings);
			}
		} catch (err) {
			if (err instanceof MobilizeError && err.status === 403) {
				report.sessionExpired = true;
				report.errors.push('Mobilize session expired (403) — refresh MOBILIZE_COOKIE');
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
				(await getPublicEvent(record.mobilizeEventId));
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
			const payload = payloadForPlan(plan, imageUrl);
			payload.timeslots = slotPlan.timeslots.map((slot) => ({
				...(slot.id ? { id: slot.id } : {}),
				starts_at_naive: slot.startsAtNaive,
				ends_at_naive: slot.endsAtNaive,
				max_attendees: slot.maxAttendees,
				private_details: null,
				virtual_join_url: null,
				zoom_meeting_id: null,
				zoom_meeting_type: null,
				waitlist_enabled: false,
				waitlist_auto_advance_enabled: false,
				close_registration_before_start_threshold: null,
				close_registration_before_start_unit: null,
			}));

			// Timeslot ids are already embedded above by reconcileTimeslots.
			await updateEvent(record.mobilizeEventId, payload, config.session);
			report.updated++;
			report.updatedTitles.push(`${plan.title} (${changes.join(', ')})`);
			log(`updated #${record.mobilizeEventId} "${plan.title}" — ${changes.join(', ')}`);
		} catch (err) {
			if (err instanceof MobilizeError && err.status === 403) {
				report.sessionExpired = true;
				report.errors.push('Mobilize session expired (403) — refresh MOBILIZE_COOKIE');
				return report;
			}
			report.failed++;
			report.errors.push(`update "${plan.title}": ${err instanceof Error ? err.message : err}`);
		}
		await pause();
	}

	return report;
}

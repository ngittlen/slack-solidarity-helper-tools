// Mirrors Mobilize signups back into Solidarity as event RSVPs, server side.
//
// Companion to mobilize-sync.ts, which pushes events the other way. The
// algorithm lives in mobilize-migrator/lib/attendee-sync.ts; this supplies
// credentials from $env and a Turso-backed ledger.
//
// Two modes, both driven by the same code and differing only in scope:
//   - imminent: sessions inside a look-ahead window, run every 30 minutes so
//               organizers have accurate lists before doors open
//   - nightly:  no window, so events further out still get a rolling picture
//
// Both look back as well as forward: check-ins are recorded during and after an
// event, so a forward-only scope would never sync who actually showed up. The
// zip -> chapter map rebuilds on staleness rather than on a mode, which is why
// neither cron entry is special-cased.

import { countDistinct, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import {
	runAttendeeSync,
	type AttendeeLedger,
	type AttendeeSyncReport,
	type RsvpRecord,
	type TimeslotLink,
} from '../../../mobilize-migrator/lib/attendee-sync.js';
import { fetchChangedParticipations } from '../../../mobilize-migrator/lib/attendees.js';
import type { MobilizeParticipation } from '../../../mobilize-migrator/lib/attendees.js';
import { buildZipChapterMap } from '../../../mobilize-migrator/lib/people.js';
import { fetchAllEvents } from '../../../mobilize-migrator/lib/solidarity.js';
import { loadMobilizeApi } from './mobilize-api.js';
import {
	ATTENDEE_SYNC_MAX_NEW_PROFILES,
	SOLIDARITY_DEFAULT_CHAPTER_ID,
	SOLIDARITY_API_TOKEN,
} from './env.js';
import {
	attendeeSyncState,
	mobilizeSyncedRsvps,
	mobilizeSyncedTimeslots,
	zipChapterMap,
} from './schema.js';
import { fetchPaginated } from './solidarity-paginate.js';
import { withSolidarityWalkLock } from './solidarity-walk-lock.js';
import { fresh, takeSolidarityEvents } from './solidarity-events-handoff.js';

/** Matches the autocomplete roster walk: under Solidarity's 60-per-30s limit,
 *  so a long walk never earns a 429 in the first place. */
const ROSTER_PACE_MS = 600;

type Db = LibSQLDatabase<Record<string, unknown>>;

class TursoAttendeeLedger implements AttendeeLedger {
	constructor(private readonly db: Db) {}

	async rsvpsByAttendanceId(): Promise<Map<number, RsvpRecord>> {
		const rows = await this.db.select().from(mobilizeSyncedRsvps);
		return new Map(
			rows.map((row) => [
				row.mobilizeAttendanceId,
				{
					mobilizeAttendanceId: row.mobilizeAttendanceId,
					solidarityRsvpId: row.solidarityRsvpId,
					solidarityUserId: row.solidarityUserId,
					solidaritySessionId: row.solidaritySessionId,
					status: row.status,
					attended: row.attended,
					modifiedDate: row.mobilizeModifiedDate,
				},
			]),
		);
	}

	async recordRsvp(record: RsvpRecord): Promise<void> {
		const now = new Date().toISOString();
		const { modifiedDate, ...rest } = record;
		await this.db
			.insert(mobilizeSyncedRsvps)
			.values({ ...rest, mobilizeModifiedDate: modifiedDate, syncedAt: now })
			.onConflictDoUpdate({
				target: mobilizeSyncedRsvps.mobilizeAttendanceId,
				set: {
					solidarityRsvpId: record.solidarityRsvpId,
					solidarityUserId: record.solidarityUserId,
					solidaritySessionId: record.solidaritySessionId,
					status: record.status,
					attended: record.attended,
					mobilizeModifiedDate: modifiedDate,
					syncedAt: now,
				},
			});
	}

	/**
	 * Forget the shift pairings for a Mobilize event that has been deleted there.
	 *
	 * Only the pairings go. The event ledger row stays, because the event sync
	 * treats an event deleted in Mobilize as deliberate and does not resurrect it;
	 * so do the mirrored RSVP rows, which record what was written into Solidarity
	 * and is still true.
	 */
	async forgetEvent(mobilizeEventId: number): Promise<void> {
		await this.db
			.delete(mobilizeSyncedTimeslots)
			.where(eq(mobilizeSyncedTimeslots.mobilizeEventId, mobilizeEventId));
	}
}

export interface AttendeeSyncOptions {
	apply?: boolean;
	/**
	 * Only sync sessions starting within this many hours. OMIT it for every
	 * upcoming session — 0 is a real window of zero hours, not "no limit", and
	 * would match nothing.
	 *
	 * This bounds the run, though far less sharply than it used to: signups are
	 * fetched one request per Mobilize EVENT rather than one per shift, and an
	 * event usually carries several shifts. A windowless pass is tens of requests
	 * against a 15/s budget, so the window is now about keeping the Solidarity
	 * write side small rather than about surviving the Mobilize read side.
	 */
	windowHours?: number;
	/**
	 * Also include sessions that started this recently. Check-ins are recorded
	 * during and after an event, so without a lookback the `attended` outcome
	 * would never reach Solidarity.
	 */
	lookbackHours?: number;
	maxNewProfiles?: number;
	/**
	 * Chapters that may never win a zip, from settings.
	 *
	 * Passed in rather than read here so this module keeps its one dependency
	 * direction — it reads env and schema, never settings — and so the rebuild
	 * stays testable as "given these exclusions, produce this map" without a
	 * settings fixture standing in the way. The route is the composition root and
	 * already holds the settings it needs for its Slack alerts.
	 */
	zipExcludedChapterIds?: ReadonlySet<number>;
	/**
	 * How long this run may spend writing before it stops, in ms.
	 *
	 * The run holds a lock whose TTL is set once and never renewed, so without a
	 * budget an overrun keeps working while the next run acquires the lock and
	 * starts from the same ledger. The route derives the default from that TTL.
	 */
	budgetMs?: number;
}

export interface AttendeeSyncResult extends AttendeeSyncReport {
	dryRun: boolean;
	/** Unix seconds: the run read only the signups Mobilize changed since this,
	 *  in place of every event's. Null when it read every event. */
	changedSince: number | null;
	/** The read of changes had a signup change while it was read, so the next
	 *  run reads from the same start (readHeldStill). */
	changesHeld: boolean;
	windowHours: number | null;
	lookbackHours: number;
	zipsMapped: number;
	/** Stale zips deleted by the rebuild, when one ran. */
	zipsPruned: number;
}

/** The age at which the nightly windowless run rebuilds the zip map. Under a
 *  day, so the next night's run always finds it due, however much the start
 *  times drift. */
const ZIP_MAP_NIGHTLY_AGE_MS = 20 * 3600_000;
/** The age at which a windowed run rebuilds it: only once nightly runs have
 *  been missed. The rebuild walks every Solidarity user, minutes of paced
 *  reads that a windowed run's budget cannot stop, and the next windowed runs
 *  wait behind it. */
const ZIP_MAP_MAX_AGE_MS = 48 * 3600_000;

/** True when the derived zip map is missing, or old enough for this run to
 *  rebuild it: `windowed` runs wait longer. */
export async function zipMapIsStale(db: Db, windowed: boolean): Promise<boolean> {
	const rows = await db
		.select({ updatedAt: zipChapterMap.updatedAt })
		.from(zipChapterMap)
		.orderBy(desc(zipChapterMap.updatedAt))
		.limit(1);
	const newest = rows[0]?.updatedAt;
	if (!newest) return true;
	const maxAge = windowed ? ZIP_MAP_MAX_AGE_MS : ZIP_MAP_NIGHTLY_AGE_MS;
	return Date.now() - Date.parse(newest) > maxAge;
}

/**
 * How far the rebuilt map may shrink before the prune is treated as suspect.
 *
 * The prune below is the only thing in this app that deletes rows it did not
 * just read, and the read is a paginated walk of every Solidarity user. That
 * walk stops silently at `MAX_PAGES` and returns what it has, so a member base
 * that outgrows the cap looks exactly like a member base that shrank — and
 * pruning against it would delete real mappings that nothing rebuilds until
 * those members are walked again.
 *
 * Half is deliberately loose. The prune is meant to clear tens of stale rows
 * out of thousands, so a legitimate rebuild never approaches this; anything
 * that does is a bad read, not a quiet week.
 */
const MIN_PRUNE_RATIO = 0.5;

export interface ZipMapRefresh {
	/** Zips written by this rebuild. */
	mapped: number;
	/** Rows deleted because no member maps to them any more. */
	pruned: number;
	/** Set when the prune was skipped, and why. */
	pruneSkipped?: 'empty-result' | 'implausible-shrink';
}

/**
 * Rebuild zip -> chapter from where members actually sit. Solidarity chapters
 * have no geographic fields, so this is derived rather than fetched. Nightly is
 * often enough; the imminent pass reads the cached table.
 *
 * Authoritative, not additive. This used to upsert only, which meant a zip that
 * dropped out of the computation — every member there losing their chapter, or
 * the last one moving away — kept whatever the map last said about it, forever.
 * Nothing distinguished "we recomputed this and it still says Kent" from "we
 * have not been able to say anything about this since July". Deleting is the
 * honest answer: an absent zip falls back to the event's own chapter when a
 * profile is created and to asking the volunteer where they are in /turfs, and
 * both of those beat a mapping nobody can date.
 */
export async function refreshZipChapterMap(
	db: Db,
	excludedChapterIds: ReadonlySet<number> = new Set(),
): Promise<ZipMapRefresh> {
	// The same full /v1/users walk the settings autocomplete does, so it takes
	// the same lock and the same pacing. Two roster walks at once earn 429s,
	// drain fetchWithRetry's shared retry budget and abort a walk that was
	// minutes in — here that can kill the whole attendee sync before a single
	// signup is mirrored, and take an admin's roster walk down with it.
	const users = await withSolidarityWalkLock(() =>
		fetchPaginated<{
			address?: { zip_code?: string | null } | null;
			chapter_id?: number | null;
			chapter_ids?: number[] | null;
		}>(SOLIDARITY_API_TOKEN, '/v1/users', 'zip chapter map', '', 'attendee-sync', ROSTER_PACE_MS),
	);

	const map = buildZipChapterMap(users, excludedChapterIds);
	const now = new Date().toISOString();
	const rows = [...map].map(([zipCode, { chapterId, memberCount }]) => ({
		zipCode,
		chapterId,
		memberCount,
		updatedAt: now,
	}));

	// Chunked to stay under libsql's statement/variable limits.
	for (let i = 0; i < rows.length; i += 200) {
		await db
			.insert(zipChapterMap)
			.values(rows.slice(i, i + 200))
			.onConflictDoUpdate({
				target: zipChapterMap.zipCode,
				set: {
					chapterId: sqlExcluded('chapter_id'),
					memberCount: sqlExcluded('member_count'),
					updatedAt: now,
				},
			});
	}

	// Nothing at all came back. Never prune on this: an empty walk is a broken
	// read every time — a campaign with no members has no signups to sync either.
	if (rows.length === 0) {
		console.warn('[attendee-sync] zip map rebuild produced no rows; keeping the existing map');
		return { mapped: 0, pruned: 0, pruneSkipped: 'empty-result' };
	}

	const [{ count: existing = 0 } = {}] = await db
		.select({ count: countDistinct(zipChapterMap.zipCode) })
		.from(zipChapterMap);

	if (existing > 0 && rows.length < existing * MIN_PRUNE_RATIO) {
		console.warn(
			`[attendee-sync] zip map rebuild returned ${rows.length} zip(s) against ${existing} ` +
				'already stored — skipping the prune, since a truncated read looks exactly like this',
		);
		return { mapped: rows.length, pruned: 0, pruneSkipped: 'implausible-shrink' };
	}

	// Everything this rebuild did not just stamp. Keyed on the timestamp rather
	// than on a NOT IN over several thousand zips, which would be the same
	// question asked in a form libsql has to bind every one of them for.
	const stale = await db
		.select({ zipCode: zipChapterMap.zipCode })
		.from(zipChapterMap)
		.where(ne(zipChapterMap.updatedAt, now));
	for (let i = 0; i < stale.length; i += 200) {
		await db.delete(zipChapterMap).where(
			inArray(
				zipChapterMap.zipCode,
				stale.slice(i, i + 200).map((r) => r.zipCode),
			),
		);
	}
	if (stale.length > 0) {
		console.log(`[attendee-sync] zip map: pruned ${stale.length} zip(s) no member maps to`);
	}

	return { mapped: rows.length, pruned: stale.length };
}

/**
 * How long ago the nightly run may have last read every event for the
 * windowed runs still to read only changes. Past this, it has been failing,
 * so nothing has been finding events Mobilize deleted, and the windowed runs
 * read every event in their window, and say why, until it reads again.
 */
const FULL_READ_MAX_AGE_MS = 30 * 3600_000;
/** Read from this long before the stored start: Mobilize's clock and ours may
 *  disagree. What is read again is skipped as unchanged, from the ledger. */
const CHANGES_OVERLAP_S = 10 * 60;
/** The lookback a run takes unless told otherwise. One that looks back less
 *  drops changed signups on sessions inside this, so it stores nothing. */
const DEFAULT_LOOKBACK_HOURS = 48;

/** What the next read of changed signups covers: see attendeeSyncState. */
export interface ChangesState {
	changesFrom: number;
	retryEventIds: number[];
	fullReadAt: number | null;
}

/** The stored state, or null for none. An unreadable one is none: the run
 *  reads every event in its window rather than not running. */
async function loadChangesState(db: Db): Promise<ChangesState | null> {
	try {
		const [row] = await db
			.select({
				changesFrom: attendeeSyncState.changesFrom,
				retryEventIds: attendeeSyncState.retryEventIds,
				fullReadAt: attendeeSyncState.fullReadAt,
			})
			.from(attendeeSyncState)
			.where(eq(attendeeSyncState.id, 1));
		if (!row) return null;
		let ids: unknown = [];
		try {
			ids = JSON.parse(row.retryEventIds);
		} catch {
			// Unreadable: no retries, rather than no sync. The nightly read of
			// every event tries any failed signup again.
		}
		return {
			changesFrom: row.changesFrom,
			retryEventIds: Array.isArray(ids) ? ids.filter((id) => Number.isSafeInteger(id)) : [],
			fullReadAt: row.fullReadAt,
		};
	} catch (err) {
		console.error(
			'[attendee-sync] could not read where the last run left off, so every event in the ' +
				`window is read: ${err instanceof Error ? err.message : err}`,
		);
		return null;
	}
}

/** Store `state`. A failure is logged, not thrown: the run's writes to
 *  Solidarity are done, and its alerts still go out. The next run reads from
 *  the state stored before, which covers more, not less. */
async function saveChangesState(db: Db, state: ChangesState): Promise<void> {
	const set = {
		changesFrom: state.changesFrom,
		retryEventIds: JSON.stringify(state.retryEventIds),
		fullReadAt: state.fullReadAt,
		updatedAt: new Date().toISOString(),
	};
	try {
		await db
			.insert(attendeeSyncState)
			.values({ id: 1, ...set })
			.onConflictDoUpdate({ target: attendeeSyncState.id, set });
	} catch (err) {
		console.error(
			`[attendee-sync] could not store where this run left off: ${err instanceof Error ? err.message : err}`,
		);
	}
}

/** What the run was, for nextChangesState. */
export interface RunScope {
	/** Unix seconds: when the run began reading. */
	readFrom: number;
	/** Every upcoming shift was in scope, not just a window's. */
	allUpcoming: boolean;
	/** The run read every event, as the nightly run does. */
	fullRead: boolean;
	/** The run looked back no less than DEFAULT_LOOKBACK_HOURS. */
	fullLookback: boolean;
	/** No signup in the run's read of changes changed while it was being
	 *  read: see readHeldStill. */
	readSettled: boolean;
}

/**
 * Whether a read of changes came back with nothing changed while it was being
 * read, so no row can have slipped between its pages. The read is paged, and
 * a row that changes as the pages are read can move within the list; if it
 * moves back, the rows behind it shift forward, one onto a page already read,
 * and that one is skipped. Such a row is in the read with a time near its
 * start, so one of those, within the clocks' disagreement, means the read is
 * not trusted to have seen every row, and the next starts where it did.
 */
export function readHeldStill(
	changed: readonly { modifiedDate: number }[] | undefined,
	readFrom: number,
): boolean {
	return !changed?.some((p) => p.modifiedDate >= readFrom - CHANGES_OVERLAP_S);
}

/**
 * What the next read of changed signups covers, after a run of `scope`: null
 * when the run leaves signups unsettled that the stored state would have the
 * next run read, so it stands.
 *
 * The read of changes must have held still while it was read (readHeldStill),
 * and every upcoming shift and the whole lookback must have been in scope: a
 * windowed read of every event leaves out signups on later shifts, a shorter
 * lookback those on earlier ones, and a read of changes after it would never
 * see them again. And everything read must have been settled: written,
 * skipped for a reason no retry changes, or put on the run's `retryEvents` —
 * an event it could not read, or one with a signup it could not write. The
 * next run reads those whole, so an event or signup that fails every time
 * costs one event read a run, never the read of changes.
 */
export function nextChangesState(
	report: AttendeeSyncReport,
	scope: RunScope,
	stored: ChangesState | null,
): ChangesState | null {
	if (!scope.allUpcoming || !scope.fullLookback || !scope.readSettled) return null;
	if (report.incomplete || report.authFailed || report.abortedReason !== undefined) return null;
	return {
		changesFrom: scope.readFrom,
		retryEventIds: report.retryEvents,
		fullReadAt: scope.fullRead ? scope.readFrom : (stored?.fullReadAt ?? null),
	};
}

// drizzle has no typed `excluded` helper for sqlite upserts; this keeps the
// raw reference in one place.
function sqlExcluded(column: string) {
	return sql.raw(`excluded.${column}`);
}

export async function runSolidarityAttendeeSync(
	db: Db,
	options: AttendeeSyncOptions = {},
): Promise<AttendeeSyncResult> {
	const apply = options.apply ?? true;
	// Started before the reads, which are part of what has to fit in the budget.
	// A junk override falls back to no budget rather than to NaN: `Date.now() +
	// NaN` is NaN and every comparison against it is false, which would silently
	// disable the stop it was meant to tighten.
	const writeDeadline =
		Number.isFinite(options.budgetMs) && (options.budgetMs as number) > 0
			? Date.now() + (options.budgetMs as number)
			: undefined;
	const api = loadMobilizeApi('the attendee sync');
	const windowHours = options.windowHours ?? null;
	const lookbackHours = options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;

	// Taken first: the zip map's rebuild below walks every Solidarity user for
	// minutes, and the Mobilize sync's read is only good for so long. Its age
	// is asked again where it is used, after the rebuild.
	const handed = takeSolidarityEvents();

	// Rebuilt on staleness rather than on a separate nightly schedule, so this
	// whole sync needs only one cron entry. Walking every Solidarity user is
	// expensive, hence once a day, by the nightly run unless it has been missed.
	let zipsMapped = 0;
	let zipsPruned = 0;
	if (apply && (await zipMapIsStale(db, windowHours !== null))) {
		const refresh = await refreshZipChapterMap(db, options.zipExcludedChapterIds);
		zipsMapped = refresh.mapped;
		zipsPruned = refresh.pruned;
	}

	const now = Date.now();
	// Before any read: a signup Mobilize changes while this run reads must
	// fall after it.
	const readFrom = Math.floor(now / 1000);

	// The windowed runs, every half hour, read only the signups Mobilize has
	// changed since the last run that mirrored everything: one paginated
	// request in place of one per event, which Mobilize answers with 429s
	// and 30-second waits. A changed signup can be on any shift, so these runs
	// take every upcoming shift, not just the window's. The nightly run reads
	// every event, which also finds events Mobilize has deleted. Any trouble
	// reading the changes, and the run reads every event in its window.
	let changed: MobilizeParticipation[] | undefined;
	let changedSince: number | null = null;
	const stored = await loadChangesState(db);
	const fullReadFresh =
		stored?.fullReadAt != null && now - stored.fullReadAt * 1000 <= FULL_READ_MAX_AGE_MS;
	if (windowHours !== null && stored !== null && !fullReadFresh) {
		console.warn(
			'[attendee-sync] no nightly read of every event since ' +
				(stored.fullReadAt == null
					? 'this state was stored'
					: new Date(stored.fullReadAt * 1000).toISOString()) +
				', so every event in the window is read',
		);
	}
	if (windowHours !== null && stored !== null && fullReadFresh) {
		try {
			changed = await fetchChangedParticipations(stored.changesFrom - CHANGES_OVERLAP_S, api);
			changedSince = stored.changesFrom - CHANGES_OVERLAP_S;
		} catch (err) {
			console.warn(
				'[attendee-sync] could not read the signups changed since the last run, ' +
					`so every event in the window is read: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	const allUpcoming = windowHours === null || changed !== undefined;
	const upperBound = allUpcoming ? null : now + windowHours! * 3600_000;
	const lowerBound = now - lookbackHours * 3600_000;

	// Which Mobilize timeslots to read, from pairings the event sync recorded.
	const pairings = await db.select().from(mobilizeSyncedTimeslots);

	// Session start times come from Solidarity, which is also where the owning
	// chapter lives (the fallback when a zip can't be mapped).
	const events =
		handed && fresh(handed) ? handed.events : await fetchAllEvents(SOLIDARITY_API_TOKEN);
	const sessionMeta = new Map<
		number,
		{
			startsAt: number;
			chapterId: number | null;
			capacity: number | null;
			eventTitle: string;
			eventUrl: string | null;
		}
	>();
	for (const event of events) {
		const chapterId = event.scope_type === 'Chapter' ? event.scope_id : null;
		for (const session of event.event_sessions) {
			sessionMeta.set(session.id, {
				startsAt: Date.parse(session.start_time),
				chapterId,
				// Solidarity uses 0 for "no cap", the same convention transform.ts
				// handles on the way out. Anything at or below zero is uncapped.
				capacity: (session.max_capacity ?? 0) > 0 ? session.max_capacity : null,
				eventTitle: event.title,
				// The public signup page. Not where the cap is edited, but it is the
				// one URL Solidarity gives us, and it identifies the event at a glance
				// — which a bare session id in a Slack alert does not.
				eventUrl: event.event_page_url,
			});
		}
	}

	const links: TimeslotLink[] = [];
	// Paired timeslots whose session Solidarity did not list this time: a
	// changed signup on one is not lost to a session missing for one run.
	const unlinkedTimeslots = new Map<number, number>();
	for (const pairing of pairings) {
		const meta = sessionMeta.get(pairing.solidaritySessionId);
		if (!meta || !Number.isFinite(meta.startsAt)) {
			unlinkedTimeslots.set(pairing.mobilizeTimeslotId, pairing.mobilizeEventId);
			continue;
		}
		if (meta.startsAt < lowerBound) continue;
		if (upperBound !== null && meta.startsAt > upperBound) continue;
		links.push({
			mobilizeTimeslotId: pairing.mobilizeTimeslotId,
			mobilizeEventId: pairing.mobilizeEventId,
			solidarityEventId: pairing.solidarityEventId,
			solidaritySessionId: pairing.solidaritySessionId,
			eventChapterId: meta.chapterId,
			startsAt: meta.startsAt,
			sessionCapacity: meta.capacity,
			eventTitle: meta.eventTitle,
			eventUrl: meta.eventUrl,
		});
	}

	const zipRows = await db.select().from(zipChapterMap);
	const zipChapters = new Map(zipRows.map((row) => [row.zipCode, { chapterId: row.chapterId }]));

	const report = await runAttendeeSync(
		links,
		{
			api,
			solidarityToken: SOLIDARITY_API_TOKEN,
			apply,
			maxNewProfiles: options.maxNewProfiles ?? ATTENDEE_SYNC_MAX_NEW_PROFILES,
			writeDeadline,
			log: (message) => console.log(`[attendee-sync] ${message}`),
			changed,
			retryEvents: changed !== undefined ? stored!.retryEventIds : undefined,
			unlinkedTimeslots,
			// The over-capacity check and the retries stay on the window's
			// shifts, as when the run reads only the window.
			windowEnd: changed !== undefined ? now + windowHours! * 3600_000 : undefined,
		},
		new TursoAttendeeLedger(db),
		zipChapters,
		SOLIDARITY_DEFAULT_CHAPTER_ID || null,
	);

	const scope: RunScope = {
		readFrom,
		allUpcoming,
		fullRead: windowHours === null,
		fullLookback: lookbackHours >= DEFAULT_LOOKBACK_HOURS,
		readSettled: readHeldStill(changed, readFrom),
	};
	const next = apply ? nextChangesState(report, scope, stored) : null;
	if (next !== null) await saveChangesState(db, next);

	return {
		...report,
		dryRun: !apply,
		changedSince,
		changesHeld: changed !== undefined && !scope.readSettled,
		windowHours,
		lookbackHours,
		zipsMapped,
		zipsPruned,
	};
}

export type { AttendeeSyncReport };

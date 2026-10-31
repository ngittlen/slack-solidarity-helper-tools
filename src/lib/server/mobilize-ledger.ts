// Turso-backed ledger for the Mobilize event sync.
//
// Deliberately free of $env and $lib imports — only drizzle and schema.js — so
// the CLI (mobilize-migrator/migrate.ts, which runs outside the Vite bundle via
// tsx) can share it with the SvelteKit endpoint. There is exactly one record of
// what has been created, which is the whole point: a second file-based ledger
// used to live alongside this one and drifted the moment the server ran.

import { eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import type {
	Ledger,
	LedgerRecord,
	PushedCap,
	TimeslotPairing,
} from '../../../mobilize-migrator/lib/sync.js';
import {
	mobilizeGeocodedZips,
	mobilizeSyncedEvents,
	mobilizeSyncedImages,
	mobilizeSyncedTimeslots,
} from './schema.js';

export type LedgerDb = LibSQLDatabase<Record<string, unknown>>;

export class TursoLedger implements Ledger {
	/** The geocoded zips and copied images, read once on first use. A run asks
	 *  for one per event — a hundred single-row reads, one after another —
	 *  and both tables are a few hundred rows. Kept current by recordZip and
	 *  recordImage, and the ledger lives for one run. A read that fails is
	 *  forgotten, so the next lookup tries again rather than failing too. */
	private zips: Promise<Map<string, string>> | null = null;
	private images: Promise<Map<string, string>> | null = null;

	constructor(private readonly db: LedgerDb) {}

	private zipCache(): Promise<Map<string, string>> {
		this.zips ??= this.db
			.select({ point: mobilizeGeocodedZips.point, postalCode: mobilizeGeocodedZips.postalCode })
			.from(mobilizeGeocodedZips)
			.then((rows) => new Map(rows.map((r) => [r.point, r.postalCode])))
			.catch((err: unknown) => {
				this.zips = null;
				throw err;
			});
		return this.zips;
	}

	private imageCache(): Promise<Map<string, string>> {
		this.images ??= this.db
			.select({
				sourceUrl: mobilizeSyncedImages.sourceUrl,
				mobilizeUrl: mobilizeSyncedImages.mobilizeUrl,
			})
			.from(mobilizeSyncedImages)
			.then((rows) => new Map(rows.map((r) => [r.sourceUrl, r.mobilizeUrl])))
			.catch((err: unknown) => {
				this.images = null;
				throw err;
			});
		return this.images;
	}

	async all(): Promise<LedgerRecord[]> {
		return this.db
			.select({
				key: mobilizeSyncedEvents.key,
				mobilizeEventId: mobilizeSyncedEvents.mobilizeEventId,
				title: mobilizeSyncedEvents.title,
			})
			.from(mobilizeSyncedEvents);
	}

	async record(entry: LedgerRecord): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.insert(mobilizeSyncedEvents)
			.values({ ...entry, createdAt: now, lastSyncedAt: now })
			.onConflictDoUpdate({
				target: mobilizeSyncedEvents.key,
				set: { mobilizeEventId: entry.mobilizeEventId, title: entry.title, lastSyncedAt: now },
			});
	}

	async imageFor(sourceUrl: string): Promise<string | null> {
		return (await this.imageCache()).get(sourceUrl) ?? null;
	}

	/** Upserts rather than ignoring a conflict: a re-upload happens precisely
	 *  because the recorded URL was no longer usable, and keeping the old row
	 *  would re-upload the same image every night forever. */
	async recordImage(sourceUrl: string, mobilizeUrl: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.insert(mobilizeSyncedImages)
			.values({ sourceUrl, mobilizeUrl, uploadedAt: now })
			.onConflictDoUpdate({
				target: mobilizeSyncedImages.sourceUrl,
				set: { mobilizeUrl, uploadedAt: now },
			});
		// Only a cache already read: loading one here could fail a write that
		// has already landed.
		(await this.images?.catch(() => null))?.set(sourceUrl, mobilizeUrl);
	}

	/** Geocoded once per venue: Mobilize requires a postal code, and Solidarity
	 *  frequently has none. */
	async zipFor(point: string): Promise<string | null> {
		return (await this.zipCache()).get(point) ?? null;
	}

	async recordZip(point: string, postalCode: string): Promise<void> {
		await this.db
			.insert(mobilizeGeocodedZips)
			.values({ point, postalCode, lookedUpAt: new Date().toISOString() })
			.onConflictDoNothing();
		// The first lookup wins, as the insert does. Only a cache already read,
		// as in recordImage.
		const zips = await this.zips?.catch(() => null);
		if (zips && !zips.has(point)) zips.set(point, postalCode);
	}

	/**
	 * What we last sent as each shift's `max_attendees`.
	 *
	 * Rows written before capacity tracking carry NULL, which reads as "uncapped".
	 * That is the safe way round: a capped shift then looks like a change and gets
	 * its cap established on the next pass, where the opposite would leave a real
	 * cap unpushed forever.
	 */
	async pushedCaps(): Promise<Map<number, number | null>> {
		const rows = await this.db
			.select({
				id: mobilizeSyncedTimeslots.mobilizeTimeslotId,
				cap: mobilizeSyncedTimeslots.pushedMaxAttendees,
			})
			.from(mobilizeSyncedTimeslots);
		return new Map(rows.map((row) => [row.id, row.cap ?? null]));
	}

	/** Written only after the create or update that carried these actually landed. */
	async recordPushedCaps(entries: PushedCap[]): Promise<void> {
		if (entries.length === 0) return;
		// One batch: one round trip, and one turn of the write lock.
		await this.batch(
			entries.map((entry) =>
				this.db
					.update(mobilizeSyncedTimeslots)
					.set({ pushedMaxAttendees: entry.maxAttendees })
					.where(eq(mobilizeSyncedTimeslots.mobilizeTimeslotId, entry.mobilizeTimeslotId)),
			),
		);
	}

	/** Consumed by the attendee sync to file a signup against the right session. */
	async recordTimeslots(pairings: TimeslotPairing[]): Promise<void> {
		if (pairings.length === 0) return;
		const now = new Date().toISOString();
		// One batch, as above: every event the run passes rewrites its pairings.
		await this.batch(
			pairings.map((pairing) =>
				this.db
					.insert(mobilizeSyncedTimeslots)
					.values({ ...pairing, updatedAt: now })
					.onConflictDoUpdate({
						target: mobilizeSyncedTimeslots.mobilizeTimeslotId,
						set: {
							solidarityEventId: pairing.solidarityEventId,
							solidaritySessionId: pairing.solidaritySessionId,
							updatedAt: now,
						},
					}),
			),
		);
	}

	/** drizzle types a batch as a non-empty tuple; callers check for empty. */
	private async batch(statements: unknown[]): Promise<void> {
		await this.db.batch(statements as unknown as Parameters<LedgerDb['batch']>[0]);
	}
}

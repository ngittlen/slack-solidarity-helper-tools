// Turso-backed ledger for the partner-org Mobilize import.
//
// Like mobilize-ledger.ts, free of $env and $lib imports so it stays usable
// outside the Vite bundle.

import { eq, inArray, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import type {
	ImportLedger,
	ImportRecord,
	ImportStatus,
} from '../../../mobilize-migrator/lib/import.js';
import { mobilizeImportedEvents, mobilizeImportedTimeslots } from './schema.js';

type Db = LibSQLDatabase<Record<string, unknown>>;

export class TursoImportLedger implements ImportLedger {
	constructor(
		private readonly db: Db,
		private readonly sourceOrgId: number,
	) {}

	async all(): Promise<ImportRecord[]> {
		const [events, timeslots] = await Promise.all([
			this.db
				.select({
					mobilizeEventId: mobilizeImportedEvents.mobilizeEventId,
					solidarityEventId: mobilizeImportedEvents.solidarityEventId,
					status: mobilizeImportedEvents.status,
					title: mobilizeImportedEvents.title,
					failedAttempts: mobilizeImportedEvents.failedAttempts,
					stalledReportedAt: mobilizeImportedEvents.stalledReportedAt,
				})
				.from(mobilizeImportedEvents),
			this.db
				.select({
					mobilizeTimeslotId: mobilizeImportedTimeslots.mobilizeTimeslotId,
					mobilizeEventId: mobilizeImportedTimeslots.mobilizeEventId,
				})
				.from(mobilizeImportedTimeslots),
		]);
		const slotsByEvent = new Map<number, Set<number>>();
		for (const slot of timeslots) {
			const set = slotsByEvent.get(slot.mobilizeEventId) ?? new Set<number>();
			set.add(slot.mobilizeTimeslotId);
			slotsByEvent.set(slot.mobilizeEventId, set);
		}
		return events.map((row) => ({
			...row,
			status: row.status as ImportStatus,
			importedTimeslotIds: slotsByEvent.get(row.mobilizeEventId) ?? new Set(),
		}));
	}

	async recordEvent(entry: {
		mobilizeEventId: number;
		solidarityEventId: number | null;
		status: ImportStatus;
		title: string;
	}): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.insert(mobilizeImportedEvents)
			.values({ ...entry, sourceOrgId: this.sourceOrgId, createdAt: now, updatedAt: now })
			.onConflictDoUpdate({
				target: mobilizeImportedEvents.mobilizeEventId,
				set: {
					solidarityEventId: entry.solidarityEventId,
					status: entry.status,
					title: entry.title,
					failedAttempts: 0,
					updatedAt: now,
				},
			});
	}

	async recordTimeslot(entry: {
		mobilizeTimeslotId: number;
		mobilizeEventId: number;
		solidaritySessionId: number | null;
	}): Promise<void> {
		await this.db
			.insert(mobilizeImportedTimeslots)
			.values({ ...entry, createdAt: new Date().toISOString() })
			.onConflictDoUpdate({
				target: mobilizeImportedTimeslots.mobilizeTimeslotId,
				set: { solidaritySessionId: entry.solidaritySessionId },
			});
	}

	async markComplete(mobilizeEventId: number, pageUrl: string | null): Promise<void> {
		await this.db
			.update(mobilizeImportedEvents)
			.set({
				status: 'complete',
				solidarityPageUrl: pageUrl,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(mobilizeImportedEvents.mobilizeEventId, mobilizeEventId));
	}

	/** One upsert, so the count can't be lost to a read-then-write race. */
	async recordFailure(entry: { mobilizeEventId: number; title: string }): Promise<number> {
		const now = new Date().toISOString();
		const [row] = await this.db
			.insert(mobilizeImportedEvents)
			.values({
				mobilizeEventId: entry.mobilizeEventId,
				sourceOrgId: this.sourceOrgId,
				solidarityEventId: null,
				status: 'failing',
				title: entry.title,
				failedAttempts: 1,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: mobilizeImportedEvents.mobilizeEventId,
				set: {
					failedAttempts: sql`${mobilizeImportedEvents.failedAttempts} + 1`,
					updatedAt: now,
				},
			})
			.returning({ failedAttempts: mobilizeImportedEvents.failedAttempts });
		return row.failedAttempts;
	}

	async setStatus(mobilizeEventId: number, status: ImportStatus): Promise<void> {
		await this.db
			.update(mobilizeImportedEvents)
			.set({ status, updatedAt: new Date().toISOString() })
			.where(eq(mobilizeImportedEvents.mobilizeEventId, mobilizeEventId));
	}

	async markStalledReported(mobilizeEventIds: number[]): Promise<void> {
		if (mobilizeEventIds.length === 0) return;
		await this.db
			.update(mobilizeImportedEvents)
			.set({ stalledReportedAt: new Date().toISOString() })
			.where(inArray(mobilizeImportedEvents.mobilizeEventId, mobilizeEventIds));
	}
}

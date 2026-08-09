// Writes a door-knock provider's day of rows into door_knock_daily and
// door_knock_canvasser_daily.
//
// That is the whole job. Where the numbers come from — an Openfield scrape, a
// MiniVAN export, a file drop — lives behind DoorKnockProvider (see
// door-knock-provider.ts), so this module has nothing tool-specific in it and
// a new provider needs no changes here.
//
// Both tables are upserted on their primary keys, which is what makes a re-run
// safe: the scheduled evening snapshot and the dashboard's on-demand refresh
// (door-knock-refresh.ts) both just overwrite the day's rows with fresher
// numbers.
//
// No $env/$lib imports — the provider is injected (the HTTP endpoints wire it
// from env via door-knock-env.ts).

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { doorKnockCanvasserDaily, doorKnockDaily } from './schema.js';
import type { DoorKnockProvider } from './door-knock-provider.js';

type Database = LibSQLDatabase<Record<string, unknown>>;

export interface DoorKnockSnapshotResult {
	/** Which provider produced these rows. */
	provider: string;
	date: string;
	rowsWritten: number;
	/** Rows written to door_knock_canvasser_daily (one per turf × person). */
	canvasserRowsWritten: number;
	totalAttempts: number;
	/** Provider-authored messages for a human — the scheduled endpoint posts
	 *  these to the tracking channel. Empty on a healthy run. */
	warnings: string[];
	/** Provider-shaped run detail, passed through for logging and the JSON
	 *  response. Never interpreted here. */
	details: Record<string, unknown>;
}

export async function runDoorKnockSnapshot(
	db: Database,
	provider: DoorKnockProvider,
	now: () => Date = () => new Date(),
): Promise<DoorKnockSnapshotResult> {
	const { date, perTurf, perCanvasser, warnings, details } = await provider.collect(now());

	for (const row of perTurf) {
		await db
			.insert(doorKnockDaily)
			.values({ date, ...row })
			.onConflictDoUpdate({
				target: [doorKnockDaily.date, doorKnockDaily.code],
				set: { chapterName: row.chapterName, attempts: row.attempts, contacts: row.contacts },
			});
	}

	for (const row of perCanvasser) {
		await db
			.insert(doorKnockCanvasserDaily)
			.values({ date, ...row })
			.onConflictDoUpdate({
				target: [
					doorKnockCanvasserDaily.date,
					doorKnockCanvasserDaily.code,
					doorKnockCanvasserDaily.canvasser,
				],
				// chapterName belongs in the update, not just the insert: a turf can
				// be reassigned mid-day, and rows written before the column existed
				// carry ''. Leaving it out meant a re-run refreshed the numbers but
				// never the region.
				set: {
					chapterName: row.chapterName,
					attempts: row.attempts,
					contacts: row.contacts,
				},
			});
	}

	return {
		provider: provider.name,
		date,
		rowsWritten: perTurf.length,
		canvasserRowsWritten: perCanvasser.length,
		totalAttempts: perTurf.reduce((sum, r) => sum + r.attempts, 0),
		warnings,
		details,
	};
}

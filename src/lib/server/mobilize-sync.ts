// Nightly Solidarity -> Mobilize event sync, server side.
//
// The algorithm lives in mobilize-migrator/lib/* so the same code backs both the
// CLI scripts and this endpoint. This module supplies the two things that differ
// on the server: credentials from $env, and a Turso-backed ledger instead of a
// JSON file.
//
// Auth caveat worth remembering: Mobilize has no public write API and no
// machine credentials — MOBILIZE_COOKIE is a borrowed browser session. Mobilize
// logs in by emailed code or Google OAuth, so it cannot be refreshed
// programmatically. When it expires the sync reports sessionExpired and posts a
// Slack alert asking someone to paste a fresh cookie.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import { findDuplicate } from '../../../mobilize-migrator/lib/dedupe.js';
import { fetchPageDescriptions } from '../../../mobilize-migrator/lib/pages.js';
import { loadMobilizeSession } from './mobilize-session.js';
import { TursoLedger } from './mobilize-ledger.js';
import { fetchAllEvents } from '../../../mobilize-migrator/lib/solidarity.js';
import { runSync, type SyncReport } from '../../../mobilize-migrator/lib/sync.js';
import { planMigration } from '../../../mobilize-migrator/lib/transform.js';
import {
	MOBILIZE_ORG_ID,
	MOBILIZE_SYNC_MAX_CREATES,
	SOLIDARITY_API_TOKEN,
} from './env.js';

type Db = LibSQLDatabase<Record<string, unknown>>;

export interface MobilizeSyncOptions {
	/** When false, plan and report without writing anything. */
	apply?: boolean;
	/** Override the create guardrail for a deliberate bulk run. */
	maxCreates?: number;
}

export interface MobilizeSyncResult extends SyncReport {
	skippedNoAddress: number;
	dryRun: boolean;
}

export async function runMobilizeSync(
	db: Db,
	options: MobilizeSyncOptions = {},
): Promise<MobilizeSyncResult> {
	const apply = options.apply ?? true;
	const session = loadMobilizeSession('the Mobilize sync');

	// Both reads are independent; the pages call is what recovers the formatted
	// descriptions the events endpoint flattens.
	const [events, pageDescriptions] = await Promise.all([
		fetchAllEvents(SOLIDARITY_API_TOKEN),
		fetchPageDescriptions(SOLIDARITY_API_TOKEN),
	]);
	const { planned, skipped } = planMigration(events, Date.now(), pageDescriptions);

	const report = await runSync(
		planned,
		{
			session,
			mobilizeOrgId: MOBILIZE_ORG_ID,
			maxCreatesPerRun: options.maxCreates ?? MOBILIZE_SYNC_MAX_CREATES,
			apply,
			log: (message) => console.log(`[mobilize-sync] ${message}`),
		},
		new TursoLedger(db),
		findDuplicate,
	);

	return { ...report, skippedNoAddress: skipped.length, dryRun: !apply };
}

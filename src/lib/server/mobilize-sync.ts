// Nightly Solidarity -> Mobilize event sync, server side.
//
// The algorithm lives in mobilize-migrator/lib/* so the same code backs both the
// CLI scripts and this endpoint. This module supplies the three things that
// differ on the server: credentials from $env, the event contact from
// /settings, and a Turso-backed ledger instead of a JSON file.
//
// Auth: MOBILIZE_API_KEY must have write ("restricted") access — creating
// events and uploading images both require it. A 403 means the key is rejected
// or lost that grant, and the sync reports authFailed and posts a Slack alert.

import type { drizzle } from 'drizzle-orm/libsql';

import { findDuplicate } from '../../../mobilize-migrator/lib/dedupe.js';
import { fetchPageDescriptions } from '../../../mobilize-migrator/lib/pages.js';
import { loadMobilizeApi } from './mobilize-api.js';
import { TursoLedger } from './mobilize-ledger.js';
import { fetchAllEvents } from '../../../mobilize-migrator/lib/solidarity.js';
import { runSync, type SyncReport } from '../../../mobilize-migrator/lib/sync.js';
import { planMigration } from '../../../mobilize-migrator/lib/transform.js';
import { loadSettings } from './settings.js';
import { MOBILIZE_SYNC_MAX_CREATES, SOLIDARITY_API_TOKEN } from './env.js';

// The full drizzle type rather than LibSQLDatabase: loadSettings needs $client.
type Db = ReturnType<typeof drizzle>;

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
	const api = loadMobilizeApi('the Mobilize sync');

	// Both reads are independent; the pages call is what recovers the formatted
	// descriptions the events endpoint flattens.
	const [events, pageDescriptions, settings] = await Promise.all([
		fetchAllEvents(SOLIDARITY_API_TOKEN),
		fetchPageDescriptions(SOLIDARITY_API_TOKEN),
		loadSettings(db),
	]);
	const { planned, skipped } = planMigration(events, Date.now(), pageDescriptions);

	// The v1 API rejects a create or update with no contact, so stop here with a
	// message naming the fix rather than letting every event fail one by one.
	const contact = {
		name: settings.mobilizeContactName,
		emailAddress: settings.mobilizeContactEmail,
		phoneNumber: settings.mobilizeContactPhone,
	};
	if (!contact.emailAddress) {
		throw new Error(
			'No Mobilize event contact configured — set one on /settings, or MOBILIZE_CONTACT_EMAIL',
		);
	}

	const report = await runSync(
		planned,
		{
			api,
			contact,
			maxCreatesPerRun: options.maxCreates ?? MOBILIZE_SYNC_MAX_CREATES,
			apply,
			log: (message) => console.log(`[mobilize-sync] ${message}`),
		},
		new TursoLedger(db),
		findDuplicate,
	);

	return { ...report, skippedNoAddress: skipped.length, dryRun: !apply };
}

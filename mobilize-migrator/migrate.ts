// Syncs upcoming in-person Solidarity events into Mobilize, from the CLI.
//
//   npx tsx mobilize-migrator/migrate.ts              # dry run, writes a plan
//   npx tsx mobilize-migrator/migrate.ts --apply      # create and update events
//   npx tsx mobilize-migrator/migrate.ts --apply --limit 3
//
// A thin wrapper over lib/sync.ts — the same engine the scheduled endpoint runs,
// against the same Turso ledger. Both matter: this script once had its own copy
// of the create loop (and silently missed features added to the shared one), and
// its own JSON ledger (which drifted from the server's the moment either ran).
//
// Dry run is the default on purpose: creating an event is publicly visible and
// there is no bulk undo. Prefer the endpoint
// (POST /api/internal/mobilize-sync) for scheduled work; this is for dry runs
// and local inspection.

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TursoLedger } from '../src/lib/server/mobilize-ledger.js';
import { findDuplicate } from './lib/dedupe.js';
import { env, requireEnv } from './lib/env.js';
import { fetchPageDescriptions } from './lib/pages.js';
import { loadSession } from './lib/session.js';
import { fetchAllEvents } from './lib/solidarity.js';
import { runSync } from './lib/sync.js';
import { CAMPAIGN_TIMEZONE } from './lib/time.js';
import { planMigration } from './lib/transform.js';

const MOBILIZE_ORG_ID = 44679; // Abdul for U.S. Senate
const here = dirname(fileURLToPath(import.meta.url));
// Run artifact, not source: rewritten every run, so it lives in gitignored private/.
const PRIVATE_DIR = resolve(here, '../private');
const PLAN_PATH = resolve(PRIVATE_DIR, 'migration-plan.json');

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = args.indexOf('--limit');
const createLimit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;

// Fail fast on missing credentials rather than after a long read phase.
const session = loadSession();
// The same ledger the server writes, so the two can never disagree about what
// has already been created.
const ledger = new TursoLedger(
	drizzle(
		createClient({
			url: requireEnv('TURSO_DATABASE_URL', 'set it in .env.local'),
			authToken: env('TURSO_AUTH_TOKEN') || undefined,
		}),
	),
);

console.log('Fetching Solidarity events…');
const solidarityEvents = await fetchAllEvents();
// The events endpoint flattens descriptions to plain text; the linked
// ActionPages carry the formatted originals.
console.log('Fetching Solidarity event pages (formatted descriptions)…');
const pageDescriptions = await fetchPageDescriptions();
console.log(`  ${pageDescriptions.size} pages with descriptions`);

const { planned, skipped } = planMigration(solidarityEvents, Date.now(), pageDescriptions);
console.log(
	`  ${solidarityEvents.length} events fetched → ${planned.length} candidate Mobilize events, ${skipped.length} skipped`,
);

const report = await runSync(
	planned,
	{
		session,
		mobilizeOrgId: MOBILIZE_ORG_ID,
		// The CLI is interactive, so the runaway guard is loose here; --limit is
		// the knob you actually reach for.
		maxCreatesPerRun: Number.MAX_SAFE_INTEGER,
		createLimit,
		apply,
		log: (message) => console.log(`  ${message}`),
	},
	ledger,
	findDuplicate,
);

console.log(`\n=== ALREADY IN MOBILIZE — SKIPPING (${report.skippedExisting}) ===`);
for (const detail of report.skippedDetails) {
	console.log(`  - "${detail.title}" → ${detail.reason}`);
}

if (skipped.length > 0) {
	console.log(`\n=== NEEDS MANUAL ATTENTION (${skipped.length}) ===`);
	for (const s of skipped) {
		console.log(`  - [solidarity #${s.solidarityEventId}] ${s.title}: ${s.reason}`);
	}
}

console.log(`\n=== ${apply ? 'CREATED' : 'WILL CREATE'} (${report.created}) ===`);
for (const title of report.createdTitles) console.log(`  - ${title}`);

console.log(`\n=== ${apply ? 'UPDATED' : 'WILL UPDATE'} (${report.updated}) ===`);
for (const title of report.updatedTitles) console.log(`  - ${title}`);

for (const err of report.errors) console.error(`  ! ${err}`);

// private/ is gitignored, so it won't exist in a fresh clone.
mkdirSync(PRIVATE_DIR, { recursive: true });
writeJson(PLAN_PATH, {
	generatedAt: new Date().toISOString(),
	timezone: CAMPAIGN_TIMEZONE,
	apply,
	report,
	plannedEvents: planned,
	skippedNoAddress: skipped,
});
console.log(`\nFull plan written to ${PLAN_PATH}`);

if (report.abortedReason) console.error(`\nABORTED: ${report.abortedReason}`);
if (report.sessionExpired) {
	console.error('\nMobilize session expired — refresh MOBILIZE_COOKIE and re-run; progress is saved.');
}

console.log(
	`\n${apply ? 'Done' : 'Dry run'}: ${report.created} created, ${report.updated} updated, ` +
		`${report.unchanged} unchanged, ${report.failed} failed.`,
);
if (!apply) console.log('Re-run with --apply to write these.');

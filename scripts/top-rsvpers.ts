/**
 * Write a CSV of each chapter's most active members — the people who RSVP'd to
 * the most distinct events over a trailing window (two months by default).
 *
 * Columns: Chapter Name, RSVP count (over the past two months), Full Name,
 * Email, Phone Number.
 *
 * Usage (from project root):
 *   npx tsx --env-file=.env.local scripts/top-rsvpers.ts
 *   npx tsx --env-file=.env.local scripts/top-rsvpers.ts --out reports/top.csv
 *   npx tsx --env-file=.env.local scripts/top-rsvpers.ts --months 3 --top 20
 *   npx tsx --env-file=.env.local scripts/top-rsvpers.ts --stdout > top.csv
 *
 * Flags:
 *   --out PATH   where to write (default: top-rsvpers-YYYY-MM-DD.csv)
 *   --stdout     write the CSV to stdout instead of a file; progress goes to
 *                stderr, so `> file.csv` is clean
 *   --months N   window length in calendar months (default 2)
 *   --top N      members per chapter (default 10)
 *
 * The run is read-only — nothing is written back to Solidarity. It is also slow
 * by design: one paced request per event session in the window plus a full
 * roster walk, to stay under Solidarity's 60-requests-per-30-seconds limit.
 *
 * Required env vars: SOLIDARITY_API_TOKEN
 */

import { writeFileSync } from 'node:fs';
import { runTopRsvpers, toCsv } from '../src/lib/server/top-rsvpers.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : undefined;
}

function positiveInt(raw: string | undefined, fallback: number, label: string): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		console.error(`--${label} must be a positive integer, got: ${raw}`);
		process.exit(1);
	}
	return value;
}

const TO_STDOUT = args.includes('--stdout');
const MONTHS = positiveInt(flag('months'), 2, 'months');
const TOP_N = positiveInt(flag('top'), 10, 'top');
const OUT = flag('out') ?? `top-rsvpers-${new Date().toISOString().slice(0, 10)}.csv`;

const SOLIDARITY_API_TOKEN = process.env.SOLIDARITY_API_TOKEN ?? '';
if (!SOLIDARITY_API_TOKEN) {
	console.error('Missing required env var: SOLIDARITY_API_TOKEN');
	process.exit(1);
}

// Progress on stderr so `--stdout > file.csv` yields a clean CSV.
const log = (message: string) => console.error(`[top-rsvpers] ${message}`);

const result = await runTopRsvpers(SOLIDARITY_API_TOKEN, { months: MONTHS, topN: TOP_N, log });
const csv = toCsv(result.rows);

if (TO_STDOUT) {
	process.stdout.write(csv);
} else {
	writeFileSync(OUT, csv, 'utf8');
}

const chapters = new Set(result.rows.map((row) => row.chapterName)).size;
log(`events scanned:      ${result.eventsScanned}`);
log(`sessions in window:  ${result.sessionsInWindow} (${result.sessionsQueried} queried)`);
log(`RSVPs counted:       ${result.rsvpsCounted}`);
log(`members with RSVPs:  ${result.membersRanked}`);
log(`duplicate profiles merged by email: ${result.duplicateProfilesMerged}`);
log(`rows written:        ${result.rows.length} across ${chapters} chapters`);
if (result.unmatchedUserIds.length > 0) {
	// They still get a row, from the contact card on their RSVPs — but with no
	// roster record there is no chapter, so they land under "(no chapter)".
	// Ids only in the log; names and emails belong in the CSV, not the console.
	log(
		`${result.unmatchedUserIds.length} member(s) had RSVPs but no roster record — ` +
			`reported under "(no chapter)" (ids: ${result.unmatchedUserIds.slice(0, 10).join(', ')}` +
			`${result.unmatchedUserIds.length > 10 ? ', …' : ''})`,
	);
}
if (!TO_STDOUT) log(`wrote ${OUT}`);

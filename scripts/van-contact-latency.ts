/**
 * How fast can the app see a MiniVAN sync? Measures the two delays a "check
 * my turf synced" button would sit behind:
 *
 *   1. Job time — how long a ContactHistory changed-entity export takes from
 *      create to Complete, and to download and read.
 *   2. Surfacing lag — how long after VAN records a contact (DateCreated) it
 *      first appears in a changed-entity export. Only `--watch` can see this:
 *      a contact present in the first round has no known first sighting, so
 *      lag is measured on contacts that turn up in a later round.
 *
 * Read-only on the database. On VAN it only creates export jobs, as the
 * scheduled sync does, and never touches the sync's own cursor or job
 * (van_contact_sync_state), so it can run beside the app.
 *
 * Nothing about a person is printed: VanIDs are hashed in memory and only
 * counts and timestamps come out.
 *
 * Usage (from project root):
 *   npm run van:latency                         # one round over the last 2 hours
 *   npm run van:latency -- --watch              # a round a minute for 20 minutes
 *   npm run van:latency -- --watch --turf 3271070
 *       # sync a test contact in MiniVAN on that turf and watch for its door
 *   npm run van:latency -- --window 30 --interval 45 --for 10 --campaign other
 *
 * Flags:
 *   --window <min>    how far back each export reads (default 120)
 *   --watch           repeat until --for runs out
 *   --interval <sec>  between round starts when watching (default 60)
 *   --for <min>       how long to watch (default 20)
 *   --turf <id>       also count that turf's doors with an in-person contact,
 *                     from its stored roster. Needs VAN_ID_HASH_SECRET.
 *   --columns         print the export's column names (not values) once
 *   --campaign <key>  which campaign's key (default primary)
 *
 * Required env vars:
 *   VAN credentials (see campaign-arg.ts); TURSO_DATABASE_URL and
 *   TURSO_AUTH_TOKEN for --turf.
 */

import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import { errMessage } from '../src/lib/err-message.js';
import { vanTurfRoster } from '../src/lib/server/schema.js';
import { createVanClient } from '../src/lib/server/van/client.js';
import {
	contactTimestamp,
	IN_PERSON_CHANNEL,
	NOT_A_DOOR_CONTACT_TYPES,
} from '../src/lib/server/van/contact-sync.js';
import { csvRows, responseChunks } from '../src/lib/server/van/hull-extract.js';
import { createPersonHasher } from '../src/lib/server/van/person-hash.js';
import type { VanChangedEntityExportJob } from '../src/lib/server/van/types.js';
import { campaignCredential, campaignKeyArg } from './campaign-arg.js';

const args = process.argv.slice(2);

function numberArg(flag: string, fallback: number): number {
	const i = args.indexOf(flag);
	if (i < 0) return fallback;
	const value = Number(args[i + 1]);
	if (!Number.isFinite(value) || value <= 0) {
		console.error(`${flag} needs a positive number`);
		process.exit(1);
	}
	return value;
}

const MINUTE = 60 * 1000;
const WINDOW_MS = numberArg('--window', 120) * MINUTE;
const WATCH = args.includes('--watch');
const INTERVAL_MS = numberArg('--interval', 60) * 1000;
const WATCH_MS = numberArg('--for', 20) * MINUTE;
const TURF_ID = args.includes('--turf') ? numberArg('--turf', 0) : null;
const SHOW_COLUMNS = args.includes('--columns');
const POLL_MS = 2000;
/** Past the app's own stale-job limit is pointless; well short of it is plenty
 *  to see whether a job is a seconds thing or a minutes thing. */
const JOB_TIMEOUT_MS = 10 * MINUTE;

const credential = campaignCredential(campaignKeyArg());
const client = createVanClient({
	appName: credential.appName,
	apiKey: credential.apiKey,
	databaseMode: credential.databaseMode,
});

interface Contact {
	/** In-memory only: VanID digest, contact type and DateCreated. */
	key: string;
	vanId: string;
	created: string | null;
	canvassed: string | null;
}

interface Round {
	jobMs: number;
	readMs: number;
	rows: number;
	contacts: Contact[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const clock = (iso: string | number) => new Date(iso).toISOString().slice(11, 19) + 'Z';

function isStatus(job: VanChangedEntityExportJob, wanted: string): boolean {
	return (job.jobStatus ?? '').trim().toLowerCase() === wanted;
}

async function inPersonTypes(): Promise<Set<string>> {
	return new Set(
		(await client.contactTypes())
			.filter(
				(t) =>
					(t.channelTypeName ?? '').trim().toLowerCase() === IN_PERSON_CHANNEL &&
					!NOT_A_DOOR_CONTACT_TYPES.has((t.name ?? '').trim().toLowerCase()),
			)
			.map((t) => String(t.contactTypeId)),
	);
}

let columnsShown = false;

/** One export over [now - window, now], timed, keeping in-person rows only. */
async function runRound(inPerson: ReadonlySet<string>): Promise<Round> {
	const now = Date.now();
	const started = performance.now();
	const created = await client.createChangedEntityExportJob({
		resourceType: 'ContactHistory',
		dateChangedFrom: new Date(now - WINDOW_MS).toISOString(),
		dateChangedTo: new Date(now).toISOString(),
	});
	let job = await client.changedEntityExportJob(created.exportJobId);
	while (!isStatus(job, 'complete') && !isStatus(job, 'error')) {
		if (performance.now() - started > JOB_TIMEOUT_MS) {
			throw new Error(
				`job ${created.exportJobId} still ${job.jobStatus ?? 'unfinished'} after ${secs(JOB_TIMEOUT_MS)}`,
			);
		}
		await sleep(POLL_MS);
		job = await client.changedEntityExportJob(created.exportJobId);
	}
	if (isStatus(job, 'error')) {
		throw new Error(`job ${created.exportJobId} failed: ${job.message ?? 'no message'}`);
	}
	const jobMs = performance.now() - started;

	const readStarted = performance.now();
	const contacts: Contact[] = [];
	let rows = 0;
	for (const file of job.files ?? []) {
		const res = await fetch(file.downloadUrl);
		if (!res.ok) throw new Error(`download returned HTTP ${res.status}`);
		let header: string[] | null = null;
		let keep: Set<number> | null = null;
		let vanId = -1;
		let type = -1;
		let canvassed = -1;
		let createdCol = -1;
		for await (const row of csvRows(responseChunks(res), (i) => (i === 0 ? null : keep))) {
			if (header === null) {
				header = row.map((c) =>
					c
						.replace(/^\uFEFF/, '')
						.trim()
						.toLowerCase(),
				);
				if (SHOW_COLUMNS && !columnsShown) {
					console.log(`  columns: ${header.join(', ')}`);
					columnsShown = true;
				}
				vanId = header.indexOf('vanid');
				type = header.indexOf('contacttypeid');
				canvassed = header.indexOf('datecanvassed');
				createdCol = header.indexOf('datecreated');
				keep = new Set([vanId, type, canvassed, createdCol].filter((i) => i >= 0));
				continue;
			}
			rows++;
			const t = (row[type] ?? '').trim();
			if (!inPerson.has(t)) continue;
			const id = (row[vanId] ?? '').trim();
			if (!id) continue;
			const createdAt = createdCol >= 0 ? contactTimestamp(row[createdCol] ?? '') : null;
			contacts.push({
				key: createHash('sha256').update(`${id}|${t}|${createdAt}`).digest('hex'),
				vanId: id,
				created: createdAt,
				canvassed: canvassed >= 0 ? contactTimestamp(row[canvassed] ?? '') : null,
			});
		}
	}
	return { jobMs, readMs: performance.now() - readStarted, rows, contacts };
}

/** The turf's roster as person digest → door digest, or exit when it cannot
 *  be matched. */
async function loadRoster(turfId: number): Promise<{
	hasher: ReturnType<typeof createPersonHasher>;
	doorOf: Map<string, string>;
	doors: number;
}> {
	const secret = process.env.VAN_ID_HASH_SECRET;
	if (!secret) {
		console.error('--turf needs VAN_ID_HASH_SECRET, the same one the app uses');
		process.exit(1);
	}
	const db = drizzle(createClient(dbConfig));
	const roster = await db
		.select({ person: vanTurfRoster.personHash, door: vanTurfRoster.doorHash })
		.from(vanTurfRoster)
		.where(eq(vanTurfRoster.turfId, turfId));
	if (roster.length === 0) {
		console.error(`Turf ${turfId} has no roster in ${dbConfig.url}`);
		process.exit(1);
	}
	const doorOf = new Map(roster.map((r) => [r.person.toString('hex'), r.door.toString('hex')]));
	return {
		hasher: createPersonHasher(secret),
		doorOf,
		doors: new Set(doorOf.values()).size,
	};
}

function stats(values: number[]): string {
	if (values.length === 0) return 'none';
	const sorted = [...values].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
	return `n=${sorted.length} min ${secs(sorted[0]!)} median ${secs(at(0.5))} p90 ${secs(at(0.9))} max ${secs(sorted.at(-1)!)}`;
}

async function main(): Promise<void> {
	console.log(`Campaign key: ${credential.key}`);
	console.log(
		`Window: last ${WINDOW_MS / MINUTE} min` +
			(WATCH ? ` · a round every ${INTERVAL_MS / 1000}s for ${WATCH_MS / MINUTE} min` : ''),
	);
	const inPerson = await inPersonTypes();
	if (inPerson.size === 0) {
		console.error('VAN lists no in-person contact types for this key');
		process.exit(1);
	}

	const turf = TURF_ID === null ? null : await loadRoster(TURF_ID);
	if (turf) console.log(`Turf ${TURF_ID}: ${turf.doors} doors on its stored roster`);

	const seen = new Set<string>();
	const jobTimes: number[] = [];
	const readTimes: number[] = [];
	const lags: number[] = [];
	const watchStarted = Date.now();
	let round = 0;

	for (;;) {
		round++;
		const roundStarted = Date.now();
		try {
			const r = await runRound(inPerson);
			jobTimes.push(r.jobMs);
			readTimes.push(r.readMs);
			const seenAt = Date.now();
			let fresh = 0;
			for (const c of r.contacts) {
				if (seen.has(c.key)) continue;
				seen.add(c.key);
				if (round === 1) continue;
				fresh++;
				if (c.created) lags.push(seenAt - Date.parse(c.created));
			}
			const newest = r.contacts
				.map((c) => c.created)
				.filter((c): c is string => c !== null)
				.sort()
				.at(-1);
			let line =
				`[${clock(roundStarted)}] round ${round}: job ${secs(r.jobMs)}, read ${secs(r.readMs)}` +
				` · ${r.rows} rows, ${r.contacts.length} in person` +
				(round > 1 ? `, ${fresh} new since last round` : '') +
				(newest
					? ` · newest created ${clock(newest)} (${secs(seenAt - Date.parse(newest))} ago)`
					: '');
			if (turf) {
				const doors = new Set<string>();
				for (const c of r.contacts) {
					const door = turf.doorOf.get(turf.hasher.person(c.vanId).toString('hex'));
					if (door) doors.add(door);
				}
				line += ` · turf: ${doors.size}/${turf.doors} doors contacted in window`;
			}
			console.log(line);
		} catch (err) {
			console.log(`[${clock(roundStarted)}] round ${round}: ${errMessage(err)}`);
		}
		if (!WATCH || Date.now() - watchStarted + INTERVAL_MS > WATCH_MS) break;
		await sleep(Math.max(0, roundStarted + INTERVAL_MS - Date.now()));
	}

	console.log('\nJob create → Complete: ' + stats(jobTimes));
	console.log('Download and read:      ' + stats(readTimes));
	if (WATCH) {
		console.log('Surfacing lag (first seen − DateCreated, contacts new after round 1):');
		console.log('  ' + stats(lags));
		console.log(
			'  Upper bound: a contact is only seen at the next round, so each lag can be up to ' +
				`${secs(INTERVAL_MS + Math.max(0, ...jobTimes))} high.`,
		);
	}
}

main().catch((err) => {
	console.error(errMessage(err));
	process.exit(1);
});

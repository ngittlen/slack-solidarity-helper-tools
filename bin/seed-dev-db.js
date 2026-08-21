// Populate a LOCAL database with synthetic dashboard data.
//
// Everything here is generated — no production rows, no real names, no Slack
// user IDs that resolve to anyone. The dashboard reads almost entirely
// aggregates keyed by (date, chapter), so fake counts exercise it faithfully.
//
// Deterministic: the same SEED produces byte-identical data, so a bug someone
// reproduces locally reproduces the same way for everyone else.
//
// Usage:
//   npm run db:seed                       # -> local.db, 120 days, seed 1
//   SEED=7 DAYS=400 npm run db:seed       # different data, longer window
//   TURSO_DATABASE_URL=file:scratch.db npm run db:seed
//
// Refuses to run against anything but a file: URL. See assertLocal below.

import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL ?? 'file:local.db';
const SEED = Number(process.env.SEED ?? 1);
const DAYS = Number(process.env.DAYS ?? 120);

/** The one line in this file that matters most. Ensures it can't be run against
 *  production. A file: URL is the only thing it will ever touch. */
function assertLocal(target) {
	if (!target.startsWith('file:')) {
		throw new Error(
			`[seed] refusing to run against a non-file URL (got ${target}).\n` +
				'        This script writes test data and must only ever touch a local file.',
		);
	}
}

assertLocal(url);

/** mulberry32 — small, fast, deterministic. Not for anything security-shaped. */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = rng(SEED);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (xs) => xs[int(0, xs.length - 1)];

const NULL_CHAPTER_SENTINEL = -1;
const DISTINCT_TOTAL_SENTINEL = -2;

/**
 * Chapters are deliberately a mix of naming conventions, because the county
 * heatmap resolves county names out of chapter names and each of these shapes
 * exercises a different branch:
 *
 *   "<County> for Abdul"   the live convention
 *   "<County> County"      the other convention already in the data
 *   punctuated counties    St. Clair / St. Joseph must survive verbatim
 *   multi-word counties    Grand Traverse
 *   non-county chapters    Detroit Metro maps to no polygon at all
 *   id with no name row    falls back to "Chapter #N"
 */
const CHAPTERS = [
	{ id: 101, name: 'Wayne for Abdul' },
	{ id: 102, name: 'Oakland for Abdul' },
	{ id: 103, name: 'Macomb for Abdul' },
	{ id: 104, name: 'Kent for Abdul' },
	{ id: 105, name: 'Washtenaw for Abdul' },
	{ id: 106, name: 'Genesee for Abdul' },
	{ id: 107, name: 'St. Clair for Abdul' },
	{ id: 108, name: 'Grand Traverse for Abdul' },
	{ id: 109, name: 'Ingham County' },
	{ id: 110, name: 'Kalamazoo County' },
	{ id: 111, name: 'Detroit Metro' },
	{ id: 112, name: 'Upper Peninsula Regional' },
];
/** Present in slack_joins and weekly growth but never given a name row, so the
 *  dashboard's `Chapter #N` fallback shows up in the UI. */
const UNNAMED_CHAPTER_ID = 199;

/** Obviously-fake canvasser names for the ticker. Two-word, unmistakably not
 *  real people, and stable so screenshots don't churn between runs. */
const CANVASSERS = [
	'Ada Testcase',
	'Bo Fixture',
	'Cy Placeholder',
	'Dee Sample',
	'Eli Mockdata',
	'Fay Stubbs',
	'Gus Dryrun',
	'Hana Sandbox',
	'Ivo Seeded',
	'Jo Synthetic',
];

const iso = (d) => d.toISOString().slice(0, 10);
function daysAgo(n) {
	const d = new Date();
	d.setUTCHours(0, 0, 0, 0);
	d.setUTCDate(d.getUTCDate() - n);
	return d;
}

/** A weekday-weighted signup curve with a late surge, so the charts show shape
 *  rather than noise. Sundays are deliberately zero to exercise zero-fill. */
function dailyIntensity(date, offsetFromEnd) {
	const dow = date.getUTCDay();
	if (dow === 0) return 0;
	const weekday = dow === 6 ? 0.45 : 1;
	const surge = 1 + Math.max(0, (60 - offsetFromEnd) / 60) * 2.5;
	return weekday * surge;
}

const client = createClient({ url });

console.log(`[seed] target ${url}`);
console.log(`[seed] seed=${SEED} days=${DAYS}`);

const TABLES = [
	'solidarity_daily_snapshots',
	'slack_joins',
	'door_knock_daily',
	'door_knock_canvasser_daily',
	'weekly_chapter_growth',
	'weekly_growth_windows',
	'chapter_channel_map',
];
for (const t of TABLES) {
	await client.execute(`DELETE FROM ${t}`);
}
console.log(`[seed] cleared ${TABLES.length} tables`);

const stmts = [];

// ---------------------------------------------------------------- chapters
for (const c of CHAPTERS) {
	stmts.push({
		sql: `INSERT INTO chapter_channel_map
		      (chapter_id, channel_id, name, last_edited_by, last_edited_by_name, last_edited_at)
		      VALUES (?, ?, ?, ?, ?, ?)`,
		args: [
			c.id,
			`C0SEED${String(c.id).padStart(5, '0')}`,
			c.name,
			'U0SEEDADMIN',
			'Seed Admin',
			new Date().toISOString(),
		],
	});
}

// ------------------------------------------------- solidarity daily snapshots
// One row per (date, chapter), plus a -1 no-chapter row and a -2 distinct-total
// row. The distinct total is deliberately BELOW the sum of bands so the
// multi-chapter dedupe path (and the dark overlay marker) is exercised.
let solidarityRows = 0;
for (let offset = DAYS; offset >= 0; offset--) {
	const date = daysAgo(offset);
	// A deliberate 5-day hole ~7 weeks back: the charts must zero-fill it.
	if (offset >= 47 && offset <= 51) continue;
	const intensity = dailyIntensity(date, offset);
	if (intensity === 0) continue;

	let sumOfBands = 0;
	for (const c of CHAPTERS) {
		const base = c.id === 101 ? 9 : c.id === 111 ? 5 : 3;
		const count = Math.round(int(0, base) * intensity);
		if (count === 0) continue;
		sumOfBands += count;
		stmts.push({
			sql: `INSERT INTO solidarity_daily_snapshots (date, chapter_id, chapter_name, count)
			      VALUES (?, ?, ?, ?)`,
			args: [iso(date), c.id, c.name, count],
		});
		solidarityRows++;
	}

	const noChapter = Math.round(int(1, 6) * intensity);
	if (noChapter > 0) {
		sumOfBands += noChapter;
		stmts.push({
			sql: `INSERT INTO solidarity_daily_snapshots (date, chapter_id, chapter_name, count)
			      VALUES (?, ?, NULL, ?)`,
			args: [iso(date), NULL_CHAPTER_SENTINEL, noChapter],
		});
		solidarityRows++;
	}

	// ~12% of members sit in more than one chapter.
	const distinct = Math.max(1, Math.round(sumOfBands * 0.88));
	stmts.push({
		sql: `INSERT INTO solidarity_daily_snapshots (date, chapter_id, chapter_name, count)
		      VALUES (?, ?, NULL, ?)`,
		args: [iso(date), DISTINCT_TOTAL_SENTINEL, distinct],
	});
	solidarityRows++;
}

// ------------------------------------------------------------- slack joins
// One row per member. chapter_ids is a JSON array: '[]' for the no-chapter
// bucket, occasionally two ids so json_each fans out and the per-chapter bands
// exceed the distinct daily total.
let joinSeq = 0;
for (let offset = DAYS; offset >= 0; offset--) {
	const date = daysAgo(offset);
	const intensity = dailyIntensity(date, offset);
	if (intensity === 0) continue;
	const joins = Math.round(int(2, 14) * intensity);
	for (let i = 0; i < joins; i++) {
		joinSeq++;
		const roll = rand();
		let chapterIds;
		if (roll < 0.14) chapterIds = [];
		else if (roll < 0.26) chapterIds = [pick(CHAPTERS).id, pick(CHAPTERS).id];
		else if (roll < 0.29) chapterIds = [UNNAMED_CHAPTER_ID];
		else chapterIds = [pick(CHAPTERS).id];
		const unique = [...new Set(chapterIds)];
		const joinedAt = new Date(date);
		joinedAt.setUTCHours(int(8, 22), int(0, 59), int(0, 59));
		stmts.push({
			sql: `INSERT INTO slack_joins (slack_user_id, email, joined_at, chapter_ids)
			      VALUES (?, ?, ?, ?)`,
			args: [
				`U0SEED${String(joinSeq).padStart(6, '0')}`,
				`seed-member-${joinSeq}@example.invalid`,
				joinedAt.toISOString(),
				JSON.stringify(unique),
			],
		});
	}
}

// -------------------------------------------------------------- door knocks
// Door-knock chapter names come from the canvassing tool in production and are
// NOT county chapters — that is why the dashboard turns the county view off for
// this card. Region names here reflect that.
const TURF_REGIONS = [
	'Detroit East',
	'Detroit West',
	'Dearborn',
	'Flint',
	'Grand Rapids',
	'Lansing',
	'Ann Arbor',
];
let doorRows = 0;
let canvasserRows = 0;
for (let offset = Math.min(DAYS, 60); offset >= 0; offset--) {
	const date = daysAgo(offset);
	const intensity = dailyIntensity(date, offset);
	if (intensity === 0) continue;
	for (const region of TURF_REGIONS) {
		const code = `SEED-${region.replace(/\W+/g, '').toUpperCase().slice(0, 6)}-${int(100, 999)}`;
		const attempts = Math.round(int(20, 120) * intensity);
		const contacts = Math.round(attempts * (0.18 + rand() * 0.22));
		stmts.push({
			sql: `INSERT INTO door_knock_daily (date, code, chapter_name, attempts, contacts)
			      VALUES (?, ?, ?, ?, ?)`,
			args: [iso(date), code, region, attempts, contacts],
		});
		doorRows++;

		// Split the turf's attempts across two or three canvassers.
		const crew = new Set();
		while (crew.size < int(2, 3)) crew.add(pick(CANVASSERS));
		let remaining = attempts;
		const members = [...crew];
		members.forEach((name, i) => {
			const share =
				i === members.length - 1 ? remaining : Math.round(remaining / (members.length - i));
			remaining -= share;
			if (share <= 0) return;
			stmts.push({
				sql: `INSERT INTO door_knock_canvasser_daily
				      (date, code, canvasser, chapter_name, attempts, contacts)
				      VALUES (?, ?, ?, ?, ?, ?)`,
				args: [iso(date), code, name, region, share, Math.round(share * 0.3)],
			});
			canvasserRows++;
		});
	}
}

// ---------------------------------------------------- weekly growth windows
let windowCount = 0;
for (let week = Math.floor(Math.min(DAYS, 84) / 7); week >= 1; week--) {
	const end = daysAgo(week * 7);
	const start = daysAgo(week * 7 + 7);
	let totalNewJoins = 0;
	const perChapter = [];
	for (const c of CHAPTERS) {
		const newJoins = int(0, 18);
		const numMembers = int(40, 400);
		totalNewJoins += newJoins;
		perChapter.push({ c, newJoins, numMembers });
	}
	stmts.push({
		sql: `INSERT INTO weekly_growth_windows (window_end, window_start, total_new_joins, computed_at)
		      VALUES (?, ?, ?, ?)`,
		args: [iso(end), iso(start), totalNewJoins, end.toISOString()],
	});
	for (const { c, newJoins, numMembers } of perChapter) {
		stmts.push({
			sql: `INSERT INTO weekly_chapter_growth
			      (window_end, chapter_id, chapter_name, slack_channel_id, new_joins, existing, num_members)
			      VALUES (?, ?, ?, ?, ?, ?, ?)`,
			args: [
				iso(end),
				c.id,
				c.name,
				`C0SEED${String(c.id).padStart(5, '0')}`,
				newJoins,
				Math.max(0, numMembers - newJoins),
				numMembers,
			],
		});
	}
	windowCount++;
}

// ---------------------------------------------------------------- app config
// Upsert rather than delete: app_config is a singleton other features read, and
// blowing it away would take unrelated settings with it.
const countdownEnd = daysAgo(-31);
countdownEnd.setUTCHours(20, 0, 0, 0);
stmts.push({
	sql: `INSERT INTO app_config (id, countdown_label, countdown_end_at, last_edited_by, last_edited_by_name, last_edited_at)
	      VALUES (1, ?, ?, ?, ?, ?)
	      ON CONFLICT(id) DO UPDATE SET
	        countdown_label = excluded.countdown_label,
	        countdown_end_at = excluded.countdown_end_at,
	        last_edited_at = excluded.last_edited_at`,
	args: [
		'Election Day',
		countdownEnd.toISOString(),
		'U0SEEDADMIN',
		'Seed Admin',
		new Date().toISOString(),
	],
});

await client.batch(stmts, 'write');

console.log(
	`[seed] chapters                  ${CHAPTERS.length} (+1 unnamed -> "Chapter #${UNNAMED_CHAPTER_ID}")`,
);
console.log(`[seed] solidarity snapshot rows  ${solidarityRows}`);
console.log(`[seed] slack_joins rows          ${joinSeq}`);
console.log(`[seed] door_knock_daily rows     ${doorRows}`);
console.log(`[seed] canvasser rows            ${canvasserRows}`);
console.log(`[seed] weekly growth windows     ${windowCount}`);
console.log('[seed] done');

client.close();

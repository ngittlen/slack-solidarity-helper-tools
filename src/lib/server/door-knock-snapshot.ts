// Nightly door-knock snapshot: canvas codes → Openfield conversation ids →
// today's leaderboards → one door_knock_daily row per (ET date, code).
//
// Openfield's /endpoint/<id>/today/ is today-only (no history), so this runs
// near the end of the canvassing day (see the door-knock-snapshot workflow)
// and freezes that day's totals. Re-running the same evening just overwrites
// the same rows with fresher numbers.
//
// Code → id resolutions are cached in door_knock_code_ids: resolving costs a
// POST per code, ids are stable, and the cache means a normal night does one
// login + one GET per code.
//
// Layout-drift safety net: the canvas is hand-edited and its structure has
// already changed under the parser once. Alongside the structured parse, a
// structure-free scan collects every code-shaped token, and any token the
// parser missed is tested against Openfield (the oracle: real codes resolve,
// ordinary uppercase words 404). Resolvable-but-unparsed codes still get
// their doors counted — under the UNMAPPED_CHAPTER band — and are reported
// in `unattributedCodes` so the caller can raise an alarm. A canvas that
// yields zero parsed codes throws outright.
//
// No $env/$lib imports — the canvas fetcher and Openfield client are injected
// (the HTTP endpoint wires them from env).

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';
import { doorKnockCodeIds, doorKnockDaily } from './schema.js';
import {
	parseConversationCodes,
	findCandidateCodes,
	type ConversationCode,
} from './door-knock-canvas.js';
import type { OpenfieldClient } from './openfield.js';
import { errMessage } from '../err-message.js';

type Database = LibSQLDatabase<Record<string, unknown>>;

/** Chart band for codes the parser couldn't attribute to a chapter — their
 *  presence means the canvas layout drifted and the parser needs updating. */
export const UNMAPPED_CHAPTER = 'Unmapped';

export interface DoorKnockSnapshotDeps {
	fetchCanvasHtml(): Promise<string>;
	openfield: OpenfieldClient;
	/** Injectable clock for tests. */
	now?: () => Date;
}

export interface DoorKnockSnapshotResult {
	date: string;
	codesFound: number;
	codesResolved: number;
	codesFailed: string[];
	/** Codes that resolve on Openfield but that the canvas parser failed to
	 *  attribute to a chapter — a canvas-layout-drift alarm. Their doors are
	 *  recorded under UNMAPPED_CHAPTER. */
	unattributedCodes: string[];
	/** Previously-cached codes no longer on the canvas whose conversations
	 *  still logged doors today (e.g. a code swapped out mid-day). Counted
	 *  under their last-known chapter so those doors aren't lost. */
	offCanvasCodes: string[];
	rowsWritten: number;
	totalAttempts: number;
}

// Openfield's "today" follows the campaign's local clock (Michigan), so the
// snapshot date must too — at the nightly cron run, UTC is already tomorrow.
export function detroitDate(now: Date): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'America/Detroit',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(now);
}

/** Resolve codes to conversation ids, cache-first. `failed` holds codes that
 *  errored or that Openfield rejected — for candidate tokens the caller
 *  ignores those (they're usually ordinary words), for parsed codes they're
 *  reported. Newly resolved ids are written back to the cache table. */
async function resolveIds(
	db: Database,
	openfield: OpenfieldClient,
	codes: string[],
	cache: ReadonlyMap<string, number>,
	nowIso: string,
): Promise<{ ids: Map<string, number>; failed: string[] }> {
	const ids = new Map<string, number>();
	if (codes.length === 0) return { ids, failed: [] };
	for (const code of codes) {
		const cachedId = cache.get(code);
		if (cachedId !== undefined) ids.set(code, cachedId);
	}

	const failed: string[] = [];
	for (const code of codes) {
		if (ids.has(code)) continue;
		try {
			const id = await openfield.resolveCode(code);
			if (id === null) {
				failed.push(code);
				continue;
			}
			ids.set(code, id);
			await db
				.insert(doorKnockCodeIds)
				.values({ code, conversationId: id, resolvedAt: nowIso })
				.onConflictDoUpdate({
					target: doorKnockCodeIds.code,
					set: { conversationId: id, resolvedAt: nowIso },
				});
		} catch (err) {
			console.error(`[door-knock] resolving ${code} failed:`, errMessage(err));
			failed.push(code);
		}
	}
	return { ids, failed };
}

export async function runDoorKnockSnapshot(
	db: Database,
	deps: DoorKnockSnapshotDeps,
): Promise<DoorKnockSnapshotResult> {
	const now = (deps.now ?? (() => new Date()))();
	const date = detroitDate(now);
	const nowIso = now.toISOString();

	const html = await deps.fetchCanvasHtml();
	const parsed = parseConversationCodes(html);
	if (parsed.length === 0) {
		// Zero parsed codes means the canvas moved or was restructured — fail
		// loudly rather than quietly recording an empty day.
		throw new Error('no conversation codes parsed from the canvas');
	}

	// The whole cache in one read — used for cache-first resolution AND to
	// find previously-known codes that vanished from the canvas.
	const cachedRows = await db.select().from(doorKnockCodeIds);
	const cache = new Map(cachedRows.map((r) => [r.code, r.conversationId]));

	const { ids, failed } = await resolveIds(
		db,
		deps.openfield,
		parsed.map((c) => c.code),
		cache,
		nowIso,
	);

	// Completeness check: code-shaped tokens the parser missed. Real codes
	// resolve on Openfield; ordinary uppercase words 404 and are dropped
	// silently (their resolution "failures" are expected, not reported).
	const parsedSet = new Set(parsed.map((c) => c.code));
	const candidates = findCandidateCodes(html).filter((c) => !parsedSet.has(c));
	const { ids: extraIds } = await resolveIds(db, deps.openfield, candidates, cache, nowIso);
	const unattributedCodes = [...extraIds.keys()].sort();
	if (unattributedCodes.length > 0) {
		console.error(
			`[door-knock] canvas layout drift: ${unattributedCodes.length} resolvable code(s) the parser could not attribute: ${unattributedCodes.join(', ')}`,
		);
		for (const [code, id] of extraIds) ids.set(code, id);
	}

	// Codes we knew on previous nights that are gone from today's canvas.
	// Their conversations usually just retire quietly — but when a code is
	// swapped out MID-day, the morning's doors live in the old conversation
	// and only the old code's cached id can reach them.
	const onCanvas = new Set([...parsedSet, ...candidates]);
	const offCanvasCandidates = cachedRows.filter((r) => !onCanvas.has(r.code));

	const allCodes: ConversationCode[] = [
		...parsed,
		...unattributedCodes.map((code) => ({ code, chapter: UNMAPPED_CHAPTER })),
	];

	// Fetch every resolved code's today-leaderboard. Per-code failures skip the
	// row (no zero written — an error is not "zero doors"); empty leaderboards
	// DO write a zero row so the chart has continuous per-day data.
	const fetchable = allCodes.filter((c) => ids.has(c.code));
	const rows: Array<{ code: string; chapterName: string; attempts: number; contacts: number }> =
		[];
	const settled = await Promise.allSettled(
		fetchable.map(async (c) => {
			const leaderboard = await deps.openfield.fetchToday(ids.get(c.code)!);
			return {
				code: c.code,
				chapterName: c.chapter,
				attempts: leaderboard.reduce((sum, r) => sum + r.attempts, 0),
				contacts: leaderboard.reduce((sum, r) => sum + r.contact, 0),
			};
		}),
	);
	settled.forEach((s, i) => {
		if (s.status === 'fulfilled') {
			rows.push(s.value);
		} else {
			const code = fetchable[i]!.code;
			console.error(`[door-knock] fetch for ${code} failed:`, errMessage(s.reason));
			failed.push(code);
		}
	});

	// Off-canvas actives: only conversations that logged doors today get a row
	// (a retired code's permanent zeros aren't part of the canvas contract).
	// Chapter comes from the code's most recent daily row; UNMAPPED otherwise.
	const offCanvasCodes: string[] = [];
	if (offCanvasCandidates.length > 0) {
		// Codes are CODE_RE-shaped (written by this module), so inlining the IN
		// list is safe; the filter is defense in depth.
		const inList = sql.raw(
			offCanvasCandidates
				.map((r) => r.code)
				.filter((c) => /^[A-Z0-9]{6}$/.test(c))
				.map((c) => `'${c}'`)
				.join(','),
		);
		const prevChapters = (await db.all(sql`
			SELECT code, chapter_name, MAX(date)
			FROM door_knock_daily
			WHERE code IN (${inList})
			GROUP BY code
		`)) as Array<{ code: string; chapter_name: string }>;
		const chapterByCode = new Map(prevChapters.map((r) => [r.code, r.chapter_name]));

		const offSettled = await Promise.allSettled(
			offCanvasCandidates.map((r) => deps.openfield.fetchToday(r.conversationId)),
		);
		offSettled.forEach((s, i) => {
			const code = offCanvasCandidates[i]!.code;
			if (s.status !== 'fulfilled') {
				console.error(`[door-knock] off-canvas fetch for ${code} failed:`, errMessage(s.reason));
				return;
			}
			const attempts = s.value.reduce((sum, r) => sum + r.attempts, 0);
			if (attempts === 0) return;
			offCanvasCodes.push(code);
			rows.push({
				code,
				chapterName: chapterByCode.get(code) ?? UNMAPPED_CHAPTER,
				attempts,
				contacts: s.value.reduce((sum, r) => sum + r.contact, 0),
			});
		});
		offCanvasCodes.sort();
		if (offCanvasCodes.length > 0) {
			console.error(
				`[door-knock] ${offCanvasCodes.length} code(s) removed from the canvas still logged doors today: ${offCanvasCodes.join(', ')}`,
			);
		}
	}

	for (const row of rows) {
		await db
			.insert(doorKnockDaily)
			.values({ date, ...row })
			.onConflictDoUpdate({
				target: [doorKnockDaily.date, doorKnockDaily.code],
				set: { chapterName: row.chapterName, attempts: row.attempts, contacts: row.contacts },
			});
	}

	return {
		date,
		codesFound: parsed.length,
		codesResolved: ids.size,
		codesFailed: failed,
		unattributedCodes,
		offCanvasCodes,
		rowsWritten: rows.length,
		totalAttempts: rows.reduce((sum, r) => sum + r.attempts, 0),
	};
}

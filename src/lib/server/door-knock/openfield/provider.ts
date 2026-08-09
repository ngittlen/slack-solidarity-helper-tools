// The Openfield (openfield.ai) door-knock provider: canvas codes → Openfield
// conversation ids → today's leaderboards → a day's worth of rows.
//
// Everything Openfield-shaped lives behind DoorKnockProvider.collect() — the
// snapshot writer that calls it (door-knock-snapshot.ts) knows only about
// dated rows. See door-knock-provider.ts for why the seam is drawn here.
//
// Openfield's /endpoint/<id>/today/ is today-only (no history), so a run near
// the end of the canvassing day freezes that day's totals. Re-running the same
// evening just recomputes the same rows with fresher numbers.
//
// Code → id resolutions are cached in door_knock_code_ids: resolving costs a
// POST per code, ids are stable, and the cache means a normal night does one
// login + one GET per code. That table and door_knock_canvas_archive are this
// provider's private storage — no other provider touches them.
//
// Layout-drift safety net: the canvas is hand-edited and its structure has
// already changed under the parser once. Alongside the structured parse, a
// structure-free scan collects every code-shaped token, and any token the
// parser missed is tested against Openfield (the oracle: real codes resolve,
// ordinary uppercase words 404). Resolvable-but-unparsed codes still get their
// doors counted — under UNMAPPED_CHAPTER — and raise a warning so a human
// fixes the parser. A canvas that yields zero parsed codes throws outright.
//
// No $env imports — the canvas fetcher and Openfield client are injected
// (door-knock-env.ts wires them from env) so tests run without a network.
// ($lib is fine here: only the three modules in tsconfig.migrator.json's
// include list have to stay alias-free, since tsx doesn't resolve $lib.)

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { inArray, max } from 'drizzle-orm';
import { doorKnockCanvasArchive, doorKnockCodeIds, doorKnockDaily } from '$lib/server/schema.js';
import {
	UNMAPPED_CHAPTER,
	type CanvasserDayRow,
	type DoorKnockDayRows,
	type DoorKnockProvider,
	type TurfDayRow,
} from '$lib/server/door-knock-provider.js';
import { parseConversationCodes, findCandidateCodes, type ConversationCode } from './canvas.js';
import type { OpenfieldClient, OpenfieldLeaderboardRow } from './client.js';
import { errMessage } from '$lib/err-message.js';

type Database = LibSQLDatabase<Record<string, unknown>>;

export interface OpenfieldProviderDeps {
	db: Database;
	fetchCanvasHtml(): Promise<string>;
	client: OpenfieldClient;
}

/** Openfield-specific run detail, surfaced through DoorKnockDayRows.details. */
export interface OpenfieldRunDetails extends Record<string, unknown> {
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
}

// Openfield's /endpoint/<id>/today/ reports whatever its Django server calls
// "today" — there's no timezone parameter (see client.ts), so the boundary is
// the server's clock, NOT the campaign's Michigan clock. And it is not ET
// midnight: on 2026-07-12, snapshot runs at 12:34–2:10 am ET still returned
// Jul 11's completed total, which only fits a rollover at or after ~3 am ET —
// i.e. midnight US Pacific. So the snapshot must stamp its rows in Openfield's
// zone; stamping in Detroit meant any run between ET midnight and the Pacific
// rollover read the prior campaign day but labelled it with today's ET date,
// the off-by-one that duplicated a day's totals into the next date.
//
// Inferred as America/Los_Angeles (handles PT DST automatically). If a winter
// observation shows the boundary stays at 3 am ET rather than shifting to 2 am
// EST, Openfield is on a fixed UTC-7 zone and this should become that instead.
export function openfieldDate(now: Date): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'America/Los_Angeles',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(now);
}

const totalAttempts = (rows: OpenfieldLeaderboardRow[]) =>
	rows.reduce((sum, r) => sum + r.attempts, 0);
const totalContacts = (rows: OpenfieldLeaderboardRow[]) =>
	rows.reduce((sum, r) => sum + r.contact, 0);

/** One row per named canvasser on a conversation's leaderboard. Unnamed rows
 *  are dropped (nothing to show on a ticker, and '' would collide on the
 *  primary key); a name appearing twice in one leaderboard is merged rather
 *  than left to fight over the same key. */
export function perCanvasserRows(
	code: string,
	chapterName: string,
	leaderboard: OpenfieldLeaderboardRow[],
): CanvasserDayRow[] {
	const byName = new Map<string, CanvasserDayRow>();
	for (const row of leaderboard) {
		const canvasser = row.canvasser.trim();
		if (canvasser === '') continue;
		const existing = byName.get(canvasser);
		if (existing) {
			existing.attempts += row.attempts;
			existing.contacts += row.contact;
		} else {
			byName.set(canvasser, {
				code,
				chapterName,
				canvasser,
				attempts: row.attempts,
				contacts: row.contact,
			});
		}
	}
	return [...byName.values()];
}

/** Resolve codes to conversation ids, cache-first. `failed` holds codes that
 *  errored or that Openfield rejected — for candidate tokens the caller
 *  ignores those (they're usually ordinary words), for parsed codes they're
 *  reported. Newly resolved ids are written back to the cache table. Also
 *  used by the canvas watcher to cache codes the moment they appear. */
export async function resolveCodeIds(
	db: Database,
	openfield: Pick<OpenfieldClient, 'resolveCode'>,
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

export function createOpenfieldProvider(deps: OpenfieldProviderDeps): DoorKnockProvider {
	const { db, client } = deps;

	return {
		name: 'openfield',
		dateFor: openfieldDate,

		async collect(now: Date): Promise<DoorKnockDayRows> {
			const date = openfieldDate(now);
			const nowIso = now.toISOString();

			const html = await deps.fetchCanvasHtml();

			// Archive the canvas verbatim BEFORE parsing — Slack has no canvas
			// version-history API, and when parsing breaks, tonight's copy is
			// exactly the evidence needed. One row per date; same-evening re-runs
			// overwrite.
			await db
				.insert(doorKnockCanvasArchive)
				.values({ date, html, fetchedAt: nowIso })
				.onConflictDoUpdate({
					target: doorKnockCanvasArchive.date,
					set: { html, fetchedAt: nowIso },
				});

			const parsed = parseConversationCodes(html);
			if (parsed.length === 0) {
				// Zero parsed codes means the canvas moved or was restructured —
				// fail loudly rather than quietly recording an empty day.
				throw new Error('no conversation codes parsed from the canvas');
			}

			// The whole cache in one read — used for cache-first resolution AND to
			// find previously-known codes that vanished from the canvas.
			const cachedRows = await db.select().from(doorKnockCodeIds);
			const cache = new Map(cachedRows.map((r) => [r.code, r.conversationId]));

			const { ids, failed } = await resolveCodeIds(
				db,
				client,
				parsed.map((c) => c.code),
				cache,
				nowIso,
			);

			// Completeness check: code-shaped tokens the parser missed. Real codes
			// resolve on Openfield; ordinary uppercase words 404 and are dropped
			// silently (their resolution "failures" are expected, not reported).
			const parsedSet = new Set(parsed.map((c) => c.code));
			const candidates = findCandidateCodes(html).filter((c) => !parsedSet.has(c));
			const { ids: extraIds } = await resolveCodeIds(db, client, candidates, cache, nowIso);
			const unattributedCodes = [...extraIds.keys()].sort();
			const warnings: string[] = [];
			if (unattributedCodes.length > 0) {
				console.error(
					`[door-knock] canvas layout drift: ${unattributedCodes.length} resolvable code(s) the parser could not attribute: ${unattributedCodes.join(', ')}`,
				);
				for (const [code, id] of extraIds) ids.set(code, id);
				// Worth a Slack ping: their doors are counted, but under the wrong
				// band until a human fixes the canvas or the parser.
				warnings.push(
					`:warning: Door-knock snapshot: ${unattributedCodes.length} code(s) on the canvas ` +
						`couldn't be matched to a chapter (layout may have changed): ${unattributedCodes.join(', ')} — ` +
						`counted under “${UNMAPPED_CHAPTER}” until the canvas or the parser is fixed.`,
				);
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

			// Fetch every resolved code's today-leaderboard. Per-code failures skip
			// the row (no zero written — an error is not "zero doors"); empty
			// leaderboards DO produce a zero row so the chart has continuous
			// per-day data.
			//
			// The leaderboard is kept, not just its totals: the same response feeds
			// door_knock_daily (per code) and door_knock_canvasser_daily (per
			// person), so the personal ticker costs no extra Openfield calls.
			const fetchable = allCodes.filter((c) => ids.has(c.code));
			const perTurf: TurfDayRow[] = [];
			const perCanvasser: CanvasserDayRow[] = [];
			const settled = await Promise.allSettled(
				fetchable.map(async (c) => ({
					code: c.code,
					chapterName: c.chapter,
					leaderboard: await client.fetchToday(ids.get(c.code)!),
				})),
			);
			settled.forEach((s, i) => {
				if (s.status === 'fulfilled') {
					const { code, chapterName, leaderboard } = s.value;
					perTurf.push({
						code,
						chapterName,
						attempts: totalAttempts(leaderboard),
						contacts: totalContacts(leaderboard),
					});
					perCanvasser.push(...perCanvasserRows(code, chapterName, leaderboard));
				} else {
					const code = fetchable[i]!.code;
					console.error(`[door-knock] fetch for ${code} failed:`, errMessage(s.reason));
					failed.push(code);
				}
			});

			// Off-canvas actives: only conversations that logged doors today get a
			// row (a retired code's permanent zeros aren't part of the canvas
			// contract). Chapter comes from the code's most recent daily row;
			// UNMAPPED otherwise.
			const offCanvasCodes: string[] = [];
			if (offCanvasCandidates.length > 0) {
				// SQLite's bare-column rule for min/max: selecting chapter_name
				// alongside MAX(date) yields the chapter from the row holding that
				// max — i.e. the code's most recent known chapter, which is what we
				// want here.
				const prevChapters = await db
					.select({
						code: doorKnockDaily.code,
						chapterName: doorKnockDaily.chapterName,
						latest: max(doorKnockDaily.date),
					})
					.from(doorKnockDaily)
					.where(
						inArray(
							doorKnockDaily.code,
							offCanvasCandidates.map((r) => r.code),
						),
					)
					.groupBy(doorKnockDaily.code);
				const chapterByCode = new Map(prevChapters.map((r) => [r.code, r.chapterName]));

				const offSettled = await Promise.allSettled(
					offCanvasCandidates.map((r) => client.fetchToday(r.conversationId)),
				);
				offSettled.forEach((s, i) => {
					const code = offCanvasCandidates[i]!.code;
					if (s.status !== 'fulfilled') {
						console.error(
							`[door-knock] off-canvas fetch for ${code} failed:`,
							errMessage(s.reason),
						);
						return;
					}
					const attempts = totalAttempts(s.value);
					if (attempts === 0) return;
					offCanvasCodes.push(code);
					const chapterName = chapterByCode.get(code) ?? UNMAPPED_CHAPTER;
					perTurf.push({
						code,
						chapterName,
						attempts,
						contacts: totalContacts(s.value),
					});
					// Doors knocked under a swapped-out code still belong to the person
					// who knocked them, so the ticker counts them too — under the
					// code's last-known chapter, same as the turf row above.
					perCanvasser.push(...perCanvasserRows(code, chapterName, s.value));
				});
				offCanvasCodes.sort();
				if (offCanvasCodes.length > 0) {
					// Routine when a code is swapped mid-day — counted, logged, and
					// deliberately NOT a warning (no Slack ping).
					console.log(
						`[door-knock] ${offCanvasCodes.length} code(s) removed from the canvas still logged doors today: ${offCanvasCodes.join(', ')}`,
					);
				}
			}

			const details: OpenfieldRunDetails = {
				codesFound: parsed.length,
				codesResolved: ids.size,
				codesFailed: failed,
				unattributedCodes,
				offCanvasCodes,
			};

			return { date, perTurf, perCanvasser, warnings, details };
		},
	};
}

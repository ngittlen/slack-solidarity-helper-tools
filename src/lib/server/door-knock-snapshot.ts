// Nightly door-knock snapshot: canvas codes → Openfield conversation ids →
// today's leaderboards → one door_knock_daily row per (ET date, code).
//
// Openfield's /endpoint/<id>/today is today-only (no history), so this runs
// near the end of the canvassing day (see the door-knock-snapshot workflow)
// and freezes that day's totals. Re-running the same evening just overwrites
// the same rows with fresher numbers.
//
// Code → id resolutions are cached in door_knock_code_ids: resolving costs a
// POST per code, ids are stable, and the cache means a normal night does one
// login + one GET per code.
//
// No $env/$lib imports — the canvas fetcher and Openfield client are injected
// (the HTTP endpoint wires them from env).

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { inArray } from 'drizzle-orm';
import { doorKnockCodeIds, doorKnockDaily } from './schema.js';
import { parseConversationCodes, type ConversationCode } from './door-knock-canvas.js';
import type { OpenfieldClient } from './openfield.js';
import { errMessage } from '../err-message.js';

type Database = LibSQLDatabase<Record<string, unknown>>;

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
	rowsWritten: number;
	totalAttempts: number;
}

// Openfield's "today" follows the campaign's local clock (Michigan), so the
// snapshot date must too — at the 03:00 UTC cron run, UTC is already tomorrow.
export function detroitDate(now: Date): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'America/Detroit',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(now);
}

async function resolveIds(
	db: Database,
	openfield: OpenfieldClient,
	codes: ConversationCode[],
	nowIso: string,
): Promise<{ ids: Map<string, number>; failed: string[] }> {
	const cached = await db
		.select()
		.from(doorKnockCodeIds)
		.where(
			inArray(
				doorKnockCodeIds.code,
				codes.map((c) => c.code),
			),
		);
	const ids = new Map(cached.map((r) => [r.code, r.conversationId]));

	const failed: string[] = [];
	for (const { code } of codes) {
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

	const codes = parseConversationCodes(await deps.fetchCanvasHtml());
	if (codes.length === 0) {
		// Zero parsed codes means the canvas moved or was restructured — fail
		// loudly rather than quietly recording an empty day.
		throw new Error('no conversation codes parsed from the canvas');
	}

	const { ids, failed } = await resolveIds(db, deps.openfield, codes, now.toISOString());

	// Fetch every resolved code's today-leaderboard. Per-code failures skip the
	// row (no zero written — an error is not "zero doors"); empty leaderboards
	// DO write a zero row so the chart has continuous per-day data.
	const rows: Array<{ code: string; chapterName: string; attempts: number; contacts: number }> =
		[];
	const settled = await Promise.allSettled(
		codes
			.filter((c) => ids.has(c.code))
			.map(async (c) => {
				const leaderboard = await deps.openfield.fetchToday(ids.get(c.code)!);
				return {
					code: c.code,
					chapterName: c.chapter,
					attempts: leaderboard.reduce((sum, r) => sum + r.attempts, 0),
					contacts: leaderboard.reduce((sum, r) => sum + r.contact, 0),
				};
			}),
	);
	const resolvedCodes = codes.filter((c) => ids.has(c.code));
	settled.forEach((s, i) => {
		if (s.status === 'fulfilled') {
			rows.push(s.value);
		} else {
			const code = resolvedCodes[i]!.code;
			console.error(`[door-knock] fetch for ${code} failed:`, errMessage(s.reason));
			failed.push(code);
		}
	});

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
		codesFound: codes.length,
		codesResolved: ids.size,
		codesFailed: failed,
		rowsWritten: rows.length,
		totalAttempts: rows.reduce((sum, r) => sum + r.attempts, 0),
	};
}

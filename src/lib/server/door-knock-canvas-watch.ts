// Reacts to Slack `file_change` events for the "Conversation Codes" canvas:
// re-fetches the canvas, resolves any codes not yet in the door_knock_code_ids
// cache, and refreshes the daily canvas archive. No notifications — the point
// is purely to capture code↔conversation ids the moment codes appear, so a
// code that's added in the morning and swapped out the same afternoon is
// still in the cache when the nightly snapshot runs its off-canvas sweep and
// counts that conversation's doors toward the day's total.
//
// file_change fires workspace-wide for every file the app can see, and fires
// repeatedly while someone is actively editing, so the watcher (a) filters by
// the canvas file id, cached with a TTL to keep the hot path to zero Slack
// calls, and (b) trailing-debounces the burst so one edit session becomes one
// check.
//
// No $env/$lib imports — everything is injected (the Slack events route wires
// it); tests construct their own watcher.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { doorKnockCanvasArchive, doorKnockCodeIds } from './schema.js';
import { parseConversationCodes } from './door-knock-canvas.js';
import { detroitDate, resolveCodeIds } from './door-knock-snapshot.js';
import type { OpenfieldClient } from './openfield.js';
import { errMessage } from '../err-message.js';

type Database = LibSQLDatabase<Record<string, unknown>>;

export interface CanvasWatcherDeps {
	db: Database;
	/** Resolve the "Conversation Codes" canvas file id (cached by the watcher). */
	findCanvasFileId(): Promise<string>;
	fetchCanvasHtml(): Promise<string>;
	openfield: Pick<OpenfieldClient, 'resolveCode'>;
	/** Trailing-debounce window for edit bursts. Default 60 s. */
	debounceMs?: number;
	/** How long the canvas file id lookup is cached. Default 10 min. */
	fileIdTtlMs?: number;
	now?: () => Date;
}

export interface CanvasWatcher {
	/** Call for every Slack file_change event; cheap for non-canvas files. */
	handleFileChange(fileId: string): Promise<void>;
	/** Run the check immediately (bypasses the debounce) — for tests. */
	_runCheckNow(): Promise<void>;
}

export function createCanvasWatcher(deps: CanvasWatcherDeps): CanvasWatcher {
	const debounceMs = deps.debounceMs ?? 60_000;
	const fileIdTtlMs = deps.fileIdTtlMs ?? 600_000;
	const now = deps.now ?? (() => new Date());

	let cachedFileId: { id: string; at: number } | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let checking = false;

	async function canvasFileId(): Promise<string | null> {
		const nowMs = now().getTime();
		if (cachedFileId && nowMs - cachedFileId.at < fileIdTtlMs) return cachedFileId.id;
		try {
			const id = await deps.findCanvasFileId();
			cachedFileId = { id, at: nowMs };
			return id;
		} catch (err) {
			console.warn('[canvas-watch] canvas file id lookup failed:', errMessage(err));
			return null;
		}
	}

	async function runCheck(): Promise<void> {
		if (checking) return;
		checking = true;
		try {
			const html = await deps.fetchCanvasHtml();
			const at = now();

			// Refresh the archive so the day's copy reflects the latest edit even
			// if the nightly snapshot later fails.
			await deps.db
				.insert(doorKnockCanvasArchive)
				.values({ date: detroitDate(at), html, fetchedAt: at.toISOString() })
				.onConflictDoUpdate({
					target: doorKnockCanvasArchive.date,
					set: { html, fetchedAt: at.toISOString() },
				});

			// Cache any code we haven't seen before while its canvas entry exists.
			const parsed = parseConversationCodes(html);
			const cachedRows = await deps.db.select().from(doorKnockCodeIds);
			const cache = new Map(cachedRows.map((r) => [r.code, r.conversationId]));
			const newCodes = parsed.map((c) => c.code).filter((code) => !cache.has(code));
			if (newCodes.length === 0) return;

			const { ids } = await resolveCodeIds(
				deps.db,
				deps.openfield,
				newCodes,
				cache,
				at.toISOString(),
			);
			if (ids.size > 0) {
				console.log(
					`[canvas-watch] cached ${ids.size} new code(s) from a canvas edit: ${[...ids.keys()].join(', ')}`,
				);
			}
		} catch (err) {
			console.error('[canvas-watch] check failed:', errMessage(err));
		} finally {
			checking = false;
		}
	}

	return {
		async handleFileChange(fileId: string): Promise<void> {
			const canvasId = await canvasFileId();
			if (canvasId === null || fileId !== canvasId) return;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				void runCheck();
			}, debounceMs);
		},
		_runCheckNow: runCheck,
	};
}

// Reacts to Slack `file_change` events for the "Conversation Codes" canvas:
// re-fetches the canvas, diffs its code set against the most recent archived
// copy (door_knock_canvas_archive — also written by the nightly snapshot),
// and posts a notification when codes were added or removed. Text-only edits
// stay silent.
//
// file_change fires workspace-wide for every file the app can see, and fires
// repeatedly while someone is actively editing, so the watcher (a) filters by
// the canvas file id, cached with a TTL to keep the hot path to zero Slack
// calls, and (b) trailing-debounces the burst so one edit session becomes one
// diff check.
//
// No $env/$lib imports — everything is injected (the Slack events route wires
// it); tests construct their own watcher.

import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { desc } from 'drizzle-orm';
import { doorKnockCanvasArchive } from './schema.js';
import { parseConversationCodes } from './door-knock-canvas.js';
import { detroitDate } from './door-knock-snapshot.js';
import { errMessage } from '../err-message.js';

type Database = LibSQLDatabase<Record<string, unknown>>;

export interface CanvasWatcherDeps {
	db: Database;
	/** Resolve the "Conversation Codes" canvas file id (cached by the watcher). */
	findCanvasFileId(): Promise<string>;
	fetchCanvasHtml(): Promise<string>;
	/** Post the change notification (the route sends it to the tracking channel). */
	postNotification(text: string): Promise<void>;
	/** Trailing-debounce window for edit bursts. Default 60 s. */
	debounceMs?: number;
	/** How long the canvas file id lookup is cached. Default 10 min. */
	fileIdTtlMs?: number;
	now?: () => Date;
}

export interface CanvasWatcher {
	/** Call for every Slack file_change event; cheap for non-canvas files. */
	handleFileChange(fileId: string): Promise<void>;
	/** Run the diff check immediately (bypasses the debounce) — for tests. */
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
			const previous = await deps.db
				.select()
				.from(doorKnockCanvasArchive)
				.orderBy(desc(doorKnockCanvasArchive.date))
				.limit(1);

			// Refresh the archive either way so the NEXT diff runs against the
			// state we just saw (and the nightly snapshot has today's copy even
			// if it later fails).
			const at = now();
			await deps.db
				.insert(doorKnockCanvasArchive)
				.values({ date: detroitDate(at), html, fetchedAt: at.toISOString() })
				.onConflictDoUpdate({
					target: doorKnockCanvasArchive.date,
					set: { html, fetchedAt: at.toISOString() },
				});

			if (previous.length === 0) return; // first sighting — nothing to diff

			const before = new Map(parseConversationCodes(previous[0]!.html).map((c) => [c.code, c.chapter]));
			const after = new Map(parseConversationCodes(html).map((c) => [c.code, c.chapter]));
			const added = [...after].filter(([code]) => !before.has(code));
			const removed = [...before].filter(([code]) => !after.has(code));
			if (added.length === 0 && removed.length === 0) return;

			const fmt = (entries: Array<[string, string]>) =>
				entries.map(([code, chapter]) => `${code} (${chapter})`).join(', ');
			const parts: string[] = [];
			if (added.length > 0) parts.push(`added ${fmt(added)}`);
			if (removed.length > 0) parts.push(`removed ${fmt(removed)}`);
			await deps.postNotification(
				`:memo: The Conversation Codes canvas changed — ${parts.join('; ')}. ` +
					`Removed codes keep counting toward the dashboard if their conversations still log doors today.`,
			);
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

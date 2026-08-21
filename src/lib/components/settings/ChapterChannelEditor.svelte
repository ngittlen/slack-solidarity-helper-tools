<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { errMessage } from '$lib/err-message.js';
	import SettingsRow from './SettingsRow.svelte';
	import MultiSelectAutocomplete from './MultiSelectAutocomplete.svelte';
	import ChapterMoveButton from './ChapterMoveButton.svelte';
	import { sharedChannelIds } from './multi-picker-logic.js';
	import { filterPickerItems } from './picker-logic.js';
	import type { PickerItem } from './picker-types.js';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	interface ChapterOption {
		id: number;
		name: string;
	}
	interface ChannelOption {
		id: string;
		name: string;
		isPrivate: boolean;
	}
	interface Entry {
		chapterId: number;
		channelId: string;
	}

	interface Props {
		chapters: ChapterOption[];
		channels: ChannelOption[];
		/** Current chapter ↔ channel rows from loadSettings. */
		entries: Entry[];
		/** Channels whose welcome message is toggled off, from loadSettings. */
		welcomeDisabledChannelIds: string[];
	}

	let { chapters, channels, entries: initialEntries, welcomeDisabledChannelIds }: Props = $props();

	// Local mirror of chapter_channel_map, updated optimistically per op and
	// reverted if the save fails. Only the id pair matters client-side.
	let entries = $state<Entry[]>(
		initialEntries.map((e) => ({ chapterId: e.chapterId, channelId: e.channelId })),
	);

	// Local mirror of the per-channel welcome-message opt-outs, same optimistic
	// discipline. Chip checkbox CHECKED = welcome on = id absent from this set.
	const welcomeDisabled = new SvelteSet<string>(welcomeDisabledChannelIds);

	let selectedChapterIds = $state<number[]>([]);
	let chapterFilter = $state('');

	const chapterItems = $derived<PickerItem<number>[]>(
		chapters.map((c) => ({ id: c.id, label: c.name })),
	);
	const filteredChapters = $derived(filterPickerItems(chapterItems, chapterFilter));

	const channelItems = $derived<PickerItem<string>[]>(
		channels.map((c) => ({
			id: c.id,
			label: `#${c.name}`,
			sublabel: c.isPrivate ? '🔒 private' : undefined,
		})),
	);

	// Plain Map is fine reactivity-wise — the whole Map is rebuilt inside
	// $derived whenever `entries` changes and is never mutated afterwards — but
	// the lint rule can't see that, and SvelteMap costs nothing here.
	const channelCountByChapter = $derived.by(() => {
		const counts = new SvelteMap<number, number>();
		for (const e of entries) {
			counts.set(e.chapterId, (counts.get(e.chapterId) ?? 0) + 1);
		}
		return counts;
	});

	// The multi-select shows the channels EVERY selected chapter maps to;
	// add/remove applies to all of them.
	const shared = $derived(sharedChannelIds(selectedChapterIds, entries));

	function toggleChapter(id: number): void {
		selectedChapterIds = selectedChapterIds.includes(id)
			? selectedChapterIds.filter((c) => c !== id)
			: [...selectedChapterIds, id];
	}

	// "Select all" selects the currently-visible (filtered) chapters, merged with
	// the existing selection — so filter-then-select-all accumulates rather than
	// discarding a prior selection. With no filter it selects every chapter.
	function selectAll(): void {
		const additions = filteredChapters
			.map((c) => c.id)
			.filter((id) => !selectedChapterIds.includes(id));
		selectedChapterIds = [...selectedChapterIds, ...additions];
	}

	function selectNone(): void {
		selectedChapterIds = [];
	}

	// --- Save flow -----------------------------------------------------------
	// Chip toggles are discrete actions, so each fires immediately (no debounce)
	// with an optimistic local apply and a revert on failure. Ops are
	// independent (one channel × the chapter selection captured at fire time),
	// so several may be in flight; the status label collapses them into one
	// saving/saved/error indicator like the other settings rows.

	interface MapOp {
		action: 'add' | 'remove';
		channelId: string;
		chapterIds: number[];
	}
	/** Toggle of the per-channel welcome-message flag (the chip checkbox). */
	interface WelcomeOp {
		action: 'welcome';
		channelId: string;
		show: boolean;
	}
	type Op = MapOp | WelcomeOp;

	let status = $state<AutosaveStatus>('idle');
	let error = $state<string | null>(null);
	let failedOps = $state<{ op: Op; message: string }[]>([]);
	let inflight = 0;
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleDismiss(): void {
		if (dismissTimer !== null) clearTimeout(dismissTimer);
		dismissTimer = setTimeout(() => {
			dismissTimer = null;
			if (status === 'saved') status = 'idle';
		}, 2000);
	}

	// Entries are compared by value, never by reference — reading from the
	// $state array yields proxies, so identity checks against objects created
	// outside it silently never match.
	function sameEntry(a: Entry, b: Entry): boolean {
		return a.chapterId === b.chapterId && a.channelId === b.channelId;
	}

	/** Apply the op locally; returns the rows actually changed so a failed save
	 *  reverts exactly what this op did and nothing a concurrent op did. */
	function applyLocal(op: MapOp): Entry[] {
		if (op.action === 'add') {
			const added = op.chapterIds
				.filter(
					(chapterId) =>
						!entries.some((e) => e.chapterId === chapterId && e.channelId === op.channelId),
				)
				.map((chapterId) => ({ chapterId, channelId: op.channelId }));
			entries = [...entries, ...added];
			return added;
		}
		const removed = entries
			.filter((e) => op.chapterIds.includes(e.chapterId) && e.channelId === op.channelId)
			.map((e) => ({ chapterId: e.chapterId, channelId: e.channelId }));
		entries = entries.filter((e) => !removed.some((r) => sameEntry(r, e)));
		return removed;
	}

	function revertLocal(op: MapOp, changed: Entry[]): void {
		if (op.action === 'add') {
			entries = entries.filter((e) => !changed.some((c) => sameEntry(c, e)));
		} else {
			entries = [...entries, ...changed];
		}
	}

	/** Optimistically apply any op and hand back its exact undo. */
	function applyLocalOp(op: Op): () => void {
		if (op.action === 'welcome') {
			const wasDisabled = welcomeDisabled.has(op.channelId);
			if (op.show) welcomeDisabled.delete(op.channelId);
			else welcomeDisabled.add(op.channelId);
			return () => {
				if (wasDisabled) welcomeDisabled.add(op.channelId);
				else welcomeDisabled.delete(op.channelId);
			};
		}
		const changed = applyLocal(op);
		return () => revertLocal(op, changed);
	}

	async function runOp(op: Op): Promise<void> {
		const undo = applyLocalOp(op);
		status = 'saving';
		error = null;
		inflight++;
		try {
			const [url, payload] =
				op.action === 'welcome'
					? ([
							'/api/settings/channel-welcome',
							{ channelId: op.channelId, showWelcome: op.show },
						] as const)
					: (['/api/settings/chapter-channels', op] as const);
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `Save failed (HTTP ${res.status})`);
			}
			if (--inflight === 0) {
				if (failedOps.length === 0) {
					status = 'saved';
					scheduleDismiss();
				} else {
					// A concurrent op failed while this one was in flight — keep
					// its error visible and retryable.
					status = 'error';
					error = failedOps[failedOps.length - 1]!.message;
				}
			}
		} catch (e) {
			inflight--;
			undo();
			const message = errMessage(e);
			failedOps = [...failedOps, { op, message }];
			status = 'error';
			error = message;
		}
	}

	function handleAdd(channelId: string): void {
		if (selectedChapterIds.length === 0) return;
		void runOp({ action: 'add', channelId, chapterIds: [...selectedChapterIds] });
	}

	function handleRemove(channelId: string): void {
		if (selectedChapterIds.length === 0) return;
		void runOp({ action: 'remove', channelId, chapterIds: [...selectedChapterIds] });
	}

	function retry(): void {
		const toRetry = failedOps;
		failedOps = [];
		for (const { op } of toRetry) void runOp(op);
	}
</script>

<div class="chapter-channel-editor">
	<div class="chapter-panel">
		<label class="chapter-filter-label">
			<span class="visually-hidden">Filter chapters</span>
			<input
				type="text"
				class="chapter-filter"
				placeholder="Filter chapters…"
				bind:value={chapterFilter}
			/>
		</label>
		<ul class="chapter-list" aria-label="Solidarity chapters">
			{#each filteredChapters as chapter (chapter.id)}
				<li>
					<label class="chapter-option">
						<input
							type="checkbox"
							checked={selectedChapterIds.includes(chapter.id)}
							onchange={() => toggleChapter(chapter.id)}
						/>
						<span class="chapter-name">{chapter.label}</span>
						{#if channelCountByChapter.get(chapter.id)}
							<span class="chapter-count">
								{channelCountByChapter.get(chapter.id)}
								{channelCountByChapter.get(chapter.id) === 1 ? 'channel' : 'channels'}
							</span>
						{/if}
					</label>
				</li>
			{:else}
				<li class="chapter-list-empty">No chapters match</li>
			{/each}
		</ul>
		<div class="chapter-actions">
			<button
				type="button"
				class="chapter-action"
				onclick={selectAll}
				disabled={filteredChapters.length === 0}
			>
				Select all{chapterFilter.trim() ? ' matching' : ''}
			</button>
			<button
				type="button"
				class="chapter-action"
				onclick={selectNone}
				disabled={selectedChapterIds.length === 0}
			>
				Select none
			</button>
			{#if selectedChapterIds.length > 0}
				<span class="chapter-selected-count">{selectedChapterIds.length} selected</span>
			{/if}
		</div>
	</div>

	<div class="channel-panel">
		{#if selectedChapterIds.length === 0}
			<p class="channel-hint">
				Select one or more chapters to edit which Slack channels their members are automatically
				added to when they join.
			</p>
		{:else}
			<SettingsRow
				label="Slack channels for {selectedChapterIds.length === 1
					? (chapters.find((c) => c.id === selectedChapterIds[0])?.name ?? 'selected chapter')
					: `${selectedChapterIds.length} selected chapters`}"
				{status}
				{error}
				onRetry={failedOps.length > 0 ? retry : undefined}
			>
				<MultiSelectAutocomplete
					items={channelItems}
					values={shared}
					onAdd={handleAdd}
					onRemove={handleRemove}
					placeholder="Add a channel…"
					showSublabel={true}
					chipCheckbox={{
						isChecked: (id) => !welcomeDisabled.has(id),
						onToggle: (id, checked) =>
							void runOp({ action: 'welcome', channelId: id, show: checked }),
						label: (label) => `Post the bot’s welcome message in ${label} when someone joins`,
					}}
				/>
				<p class="channel-note">
					The checkbox on each chip controls whether the bot posts its “everybody welcome” message
					in that channel when it adds a new member. This is per channel — it applies however the
					person’s chapters map there.
				</p>
				{#if selectedChapterIds.length > 1}
					<p class="channel-note">
						Showing only channels shared by all {selectedChapterIds.length} selected chapters. Adding
						or removing a channel applies to every selected chapter.
					</p>
				{/if}
			</SettingsRow>
		{/if}
	</div>
</div>

<div class="chapter-move-row">
	<ChapterMoveButton {channels} />
	<span class="chapter-move-hint">
		Preview and invite existing Slack members into their chapters’ channels.
	</span>
</div>

<style>
	.chapter-channel-editor {
		display: grid;
		grid-template-columns: minmax(220px, 320px) 1fr;
		gap: 24px;
		align-items: start;
		margin-top: 12px;
	}

	@media (max-width: 720px) {
		.chapter-channel-editor {
			grid-template-columns: 1fr;
		}
	}

	.chapter-filter {
		width: 100%;
		box-sizing: border-box;
		padding: 6px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-surface);
		font: inherit;
		color: inherit;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	.chapter-list {
		list-style: none;
		margin: 8px 0 0;
		padding: 4px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-surface);
		max-height: 320px;
		overflow-y: auto;
	}

	.chapter-option {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.chapter-option:hover {
		background: var(--color-bg-hover);
	}

	.chapter-name {
		flex: 1;
	}

	.chapter-count {
		font-size: 0.8em;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.chapter-list-empty {
		padding: 8px 10px;
		color: var(--color-text-muted);
		font-style: italic;
	}

	.chapter-actions {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 8px;
	}

	.chapter-action {
		background: transparent;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 0.9em;
		color: var(--color-gold);
		cursor: pointer;
		border-bottom: 1px dashed currentColor;
	}

	.chapter-action:disabled {
		color: var(--color-text-muted);
		cursor: not-allowed;
		border-bottom-color: transparent;
	}

	.chapter-selected-count {
		margin-left: auto;
		font-size: 0.85em;
		color: var(--color-text-muted);
	}

	.channel-hint,
	.channel-note {
		color: var(--color-text-muted);
		font-size: 0.9em;
		margin: 8px 0 0;
	}

	.channel-hint {
		margin: 0;
	}

	.chapter-move-row {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 20px;
		padding-top: 16px;
		border-top: 1px solid var(--color-border);
	}

	.chapter-move-hint {
		font-size: 0.85em;
		color: var(--color-text-muted);
	}
</style>

<script lang="ts">
	// Which VAN folders belong to which county chapter.
	//
	// This mapping is an INPUT to the turf catalog sync, not something it
	// discovers: a chapter with no folders here has no turf, and the sync does
	// nothing until it's filled in. It's editable before a VAN key exists
	// precisely so it can be ready the day the key lands.
	//
	// Folder ids are typed by hand — VAN shows them in the URL when you open a
	// folder — because there's no key yet to look them up with. A wrong id
	// yields no turf rather than anything unsafe, and Story 2 adds a "this
	// folder returned nothing" warning once the sync can check.

	import { errMessage } from '$lib/err-message.js';
	import SettingsRow from './SettingsRow.svelte';
	import AutocompletePicker from './AutocompletePicker.svelte';
	import DeleteConfirmButton from './DeleteConfirmButton.svelte';
	import type { PickerItem } from './picker-types.js';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';
	import { parseFolderIds, formatFolderIds } from './van-folder-ids.js';

	/** Mirrors SolidarityChapterEntry from $lib/server/autocomplete-sources.ts. */
	interface ChapterOption {
		id: number;
		name: string;
	}

	interface MappingEntry {
		chapterId: number;
		chapterName: string;
		folderIds: number[];
	}

	interface Props {
		chapters: ChapterOption[];
		/** Existing mappings from loadVanChapterFolders. */
		mappings: MappingEntry[];
	}

	let { chapters, mappings }: Props = $props();

	let rows = $state<MappingEntry[]>(mappings.map((m) => ({ ...m, folderIds: [...m.folderIds] })));
	/** Raw text per chapter, so a half-typed "1152, " isn't reformatted mid-edit. */
	let drafts = $state<Record<number, string>>(
		Object.fromEntries(mappings.map((m) => [m.chapterId, formatFolderIds(m.folderIds)])),
	);

	let status = $state<AutosaveStatus>('idle');
	let error = $state<string | null>(null);
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;

	const mappedIds = $derived(new Set(rows.map((r) => r.chapterId)));

	const chapterItems = $derived<PickerItem<number>[]>(
		chapters.filter((c) => !mappedIds.has(c.id)).map((c) => ({ id: c.id, label: c.name })),
	);

	function scheduleDismiss(): void {
		if (dismissTimer !== null) clearTimeout(dismissTimer);
		dismissTimer = setTimeout(() => {
			dismissTimer = null;
			if (status === 'saved') status = 'idle';
		}, 2000);
	}

	async function post(body: unknown): Promise<void> {
		status = 'saving';
		error = null;
		try {
			const res = await fetch('/api/settings/van-chapter-folders', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(parsed?.error ?? `Save failed (HTTP ${res.status})`);
			}
			status = 'saved';
			scheduleDismiss();
		} catch (e) {
			status = 'error';
			error = errMessage(e);
		}
	}

	function addChapter(chapterId: number): void {
		const chapter = chapters.find((c) => c.id === chapterId);
		if (!chapter || mappedIds.has(chapterId)) return;
		// Added locally with no folders yet — saving an empty list would be a
		// pointless round-trip, and the row is there to be filled in.
		rows = [...rows, { chapterId, chapterName: chapter.name, folderIds: [] }].sort((a, b) =>
			a.chapterName.localeCompare(b.chapterName),
		);
		drafts[chapterId] = '';
	}

	function commitFolders(row: MappingEntry): void {
		const parsed = parseFolderIds(drafts[row.chapterId] ?? '');
		if (!parsed.ok) {
			status = 'error';
			error = parsed.error;
			return;
		}
		// Normalise the box to what was actually stored, so the admin can see
		// duplicates collapsed and ordering applied.
		drafts[row.chapterId] = formatFolderIds(parsed.folderIds);
		row.folderIds = parsed.folderIds;
		void post({
			action: 'save',
			chapterId: row.chapterId,
			chapterName: row.chapterName,
			folderIds: parsed.folderIds,
		});
	}

	function removeChapter(chapterId: number): void {
		rows = rows.filter((r) => r.chapterId !== chapterId);
		delete drafts[chapterId];
		void post({ action: 'remove', chapterId });
	}
</script>

<div class="van-chapter-folders-editor">
	<SettingsRow label="Chapter → VAN folders" {status} {error}>
		{#if rows.length > 0}
			<ul class="mapping-list">
				{#each rows as row (row.chapterId)}
					<li class="mapping-row">
						<span class="chapter-name">{row.chapterName}</span>
						<input
							class="folder-input"
							type="text"
							inputmode="numeric"
							placeholder="e.g. 1152, 1200"
							aria-label="VAN folder ids for {row.chapterName}"
							bind:value={drafts[row.chapterId]}
							onblur={() => commitFolders(row)}
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									(e.currentTarget as HTMLInputElement).blur();
								}
							}}
						/>
						<DeleteConfirmButton
							label="Remove"
							description="Remove {row.chapterName}'s VAN folder mapping? Its turf stops being published to volunteers."
							onConfirm={() => removeChapter(row.chapterId)}
						/>
					</li>
				{/each}
			</ul>
		{/if}

		<div class="add-chapter">
			<AutocompletePicker
				items={chapterItems}
				value={null}
				onSelect={(id) => addChapter(Number(id))}
				placeholder="Add a chapter…"
			/>
		</div>

		<p class="van-chapter-folders-note">
			Turf is only visible to volunteers in chapters listed here. Folder ids come from VAN — open
			the folder and read the id from the address bar. A chapter that spans several folders takes a
			comma-separated list.
		</p>
	</SettingsRow>
</div>

<style>
	.van-chapter-folders-editor {
		margin-top: 12px;
		max-width: 720px;
	}

	.mapping-list {
		list-style: none;
		margin: 0 0 12px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.mapping-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) auto;
		align-items: center;
		gap: 10px;
	}

	.chapter-name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.folder-input {
		width: 100%;
		padding: 6px 8px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: var(--font-size-md);
		color: var(--color-text);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
	}

	.folder-input:focus-visible {
		outline: 2px solid var(--color-border-focus);
		outline-offset: 1px;
	}

	.add-chapter {
		max-width: 320px;
	}

	.van-chapter-folders-note {
		color: var(--color-text-muted);
		font-size: 0.9em;
		margin: 8px 0 0;
	}

	@media (max-width: 560px) {
		.mapping-row {
			grid-template-columns: 1fr auto;
		}

		.folder-input {
			grid-column: 1 / -1;
		}
	}
</style>

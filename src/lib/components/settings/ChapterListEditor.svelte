<script lang="ts">
	// A list of chapters, edited as chips: the shape every per-chapter exclusion
	// on /settings shares — report exclusions, ZIP exclusions, chapters hidden
	// from /turfs. Each add or remove posts `{ action, chapterId }` to `endpoint`
	// and applies optimistically, reverting if the save fails.
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';
	import { errMessage } from '$lib/err-message.js';
	import SettingsRow from './SettingsRow.svelte';
	import MultiSelectAutocomplete from './MultiSelectAutocomplete.svelte';
	import type { PickerItem } from './picker-types.js';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	interface ChapterOption {
		id: number;
		name: string;
	}

	interface Props {
		/** The chapters to pick from. */
		chapters: ChapterOption[];
		/** The chapters currently in the list, from loadSettings. */
		selectedIds: number[];
		/** The settings route that adds and removes one chapter. */
		endpoint: string;
		label: string;
		placeholder: string;
		/** What the list does, above it. */
		children: Snippet;
	}

	let { chapters, selectedIds, endpoint, label, placeholder, children }: Props = $props();

	// Local mirror of the list, seeded once from the server and updated
	// optimistically per op. A chip whose chapter has vanished from `chapters`
	// falls back to its raw id inside MultiSelectAutocomplete and stays
	// removable.
	let selected = $state<number[]>(untrack(() => [...selectedIds]));

	const chapterItems = $derived<PickerItem<number>[]>(
		chapters.map((c) => ({ id: c.id, label: c.name })),
	);

	// --- Save flow — same optimistic/revert/retry shape as AllowedUsersEditor.

	interface Op {
		action: 'add' | 'remove';
		chapterId: number;
	}

	let status = $state<AutosaveStatus>('idle');
	let error = $state<string | null>(null);
	let lastFailedOp: Op | null = $state(null);
	let inflight = 0;
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleDismiss(): void {
		if (dismissTimer !== null) clearTimeout(dismissTimer);
		dismissTimer = setTimeout(() => {
			dismissTimer = null;
			if (status === 'saved') status = 'idle';
		}, 2000);
	}

	function applyLocal(op: Op): boolean {
		if (op.action === 'add') {
			if (selected.includes(op.chapterId)) return false;
			selected = [...selected, op.chapterId];
			return true;
		}
		if (!selected.includes(op.chapterId)) return false;
		selected = selected.filter((id) => id !== op.chapterId);
		return true;
	}

	function revertLocal(op: Op): void {
		if (op.action === 'add') {
			selected = selected.filter((id) => id !== op.chapterId);
		} else if (!selected.includes(op.chapterId)) {
			selected = [...selected, op.chapterId];
		}
	}

	async function runOp(op: Op): Promise<void> {
		const changed = applyLocal(op);
		status = 'saving';
		error = null;
		inflight++;
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(op),
			});
			if (!res.ok) {
				const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(parsed?.error ?? `Save failed (HTTP ${res.status})`);
			}
			lastFailedOp = null;
			if (--inflight === 0 && status === 'saving') {
				status = 'saved';
				scheduleDismiss();
			}
		} catch (e) {
			inflight--;
			if (changed) revertLocal(op);
			status = 'error';
			error = errMessage(e);
			lastFailedOp = op;
		}
	}

	function retry(): void {
		if (!lastFailedOp) return;
		void runOp(lastFailedOp);
	}
</script>

<div class="chapter-list-editor">
	<div class="chapter-list-intro">{@render children()}</div>
	<SettingsRow {label} {status} {error} onRetry={lastFailedOp ? retry : undefined}>
		<MultiSelectAutocomplete
			items={chapterItems}
			values={selected}
			onAdd={(id) => void runOp({ action: 'add', chapterId: id })}
			onRemove={(id) => void runOp({ action: 'remove', chapterId: id })}
			{placeholder}
		/>
	</SettingsRow>
</div>

<style>
	.chapter-list-editor {
		margin-top: 12px;
		max-width: 720px;
	}

	.chapter-list-intro :global(p) {
		color: var(--color-text-muted);
		font-size: 0.9em;
		margin: 0 0 4px;
	}
</style>

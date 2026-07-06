<script lang="ts">
	import { errMessage } from '$lib/err-message.js';
	import SettingsRow from './SettingsRow.svelte';
	import MultiSelectAutocomplete from './MultiSelectAutocomplete.svelte';
	import type { PickerItem } from './picker-types.js';
	import type { AutosaveStatus } from './use-field-autosave.svelte.js';

	/** Mirrors SolidarityChapterEntry from $lib/server/autocomplete-sources.ts. */
	interface ChapterOption {
		id: number;
		name: string;
	}

	interface Props {
		chapters: ChapterOption[];
		/** Currently excluded chapter ids from loadSettings. */
		excludedIds: number[];
	}

	let { chapters, excludedIds }: Props = $props();

	// Local mirror of the exclusion list, updated optimistically per op and
	// reverted if the save fails. A chip whose chapter has vanished from the
	// live list (deleted in Solidarity) falls back to its raw id inside
	// MultiSelectAutocomplete and stays removable.
	let excluded = $state<number[]>([...excludedIds]);

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
			if (excluded.includes(op.chapterId)) return false;
			excluded = [...excluded, op.chapterId];
			return true;
		}
		if (!excluded.includes(op.chapterId)) return false;
		excluded = excluded.filter((id) => id !== op.chapterId);
		return true;
	}

	function revertLocal(op: Op): void {
		if (op.action === 'add') {
			excluded = excluded.filter((id) => id !== op.chapterId);
		} else if (!excluded.includes(op.chapterId)) {
			excluded = [...excluded, op.chapterId];
		}
	}

	async function runOp(op: Op): Promise<void> {
		const changed = applyLocal(op);
		status = 'saving';
		error = null;
		inflight++;
		try {
			const res = await fetch('/api/settings/excluded-chapters', {
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

<div class="excluded-chapters-editor">
	<p class="excluded-chapters-intro">
		Excluded chapters are left out of the <strong>weekly growth report</strong> posted to Slack
		and the <strong>dashboard signup charts</strong> — use this for test or internal-only
		chapters. Exclusion doesn’t affect anything else: new members of these chapters are still
		invited to their mapped channels.
	</p>
	<SettingsRow
		label="Excluded from reports"
		status={status}
		error={error}
		onRetry={lastFailedOp ? retry : undefined}
	>
		<MultiSelectAutocomplete
			items={chapterItems}
			values={excluded}
			onAdd={(id) => void runOp({ action: 'add', chapterId: id })}
			onRemove={(id) => void runOp({ action: 'remove', chapterId: id })}
			placeholder="Exclude a chapter…"
		/>
	</SettingsRow>
</div>

<style>
	.excluded-chapters-editor {
		margin-top: 12px;
		max-width: 720px;
	}

	.excluded-chapters-intro {
		color: var(--color-text-muted, #888);
		font-size: 0.9em;
		margin: 0 0 4px;
	}
</style>

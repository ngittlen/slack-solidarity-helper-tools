<script lang="ts">
	import ChapterListEditor from './ChapterListEditor.svelte';

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
</script>

<ChapterListEditor
	{chapters}
	selectedIds={excludedIds}
	endpoint="/api/settings/excluded-chapters"
	label="Excluded from reports"
	placeholder="Exclude a chapter…"
>
	<p>
		Excluded chapters are left out of the <strong>weekly growth report</strong> posted to Slack and
		the <strong>dashboard signup charts</strong> — use this for test or internal-only chapters. Exclusion
		doesn’t affect anything else: new members of these chapters are still invited to their mapped channels.
	</p>
</ChapterListEditor>

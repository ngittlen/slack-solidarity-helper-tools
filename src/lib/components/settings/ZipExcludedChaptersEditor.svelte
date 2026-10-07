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

	// A chip whose chapter has vanished from the live list (deleted in
	// Solidarity) stays removable — which matters more here than for report
	// exclusions, since the chapters worth excluding from zips are exactly the
	// ones on their way out.
	let { chapters, excludedIds }: Props = $props();
</script>

<ChapterListEditor
	{chapters}
	selectedIds={excludedIds}
	endpoint="/api/settings/zip-excluded-chapters"
	label="Never assigned ZIP codes"
	placeholder="Exclude a chapter from ZIP mapping…"
>
	<p>
		Chapters listed here are never assigned a ZIP code. The ZIP → chapter map is derived from where
		members live, so a superseded chapter that still holds members can out-vote the chapters that
		replaced it — use this for a retired statewide or regional chapter. The ZIP goes to the
		<strong>next chapter with members there</strong> rather than being left unmapped, and a ZIP with no
		other chapter falls back to the channel a volunteer is posting in.
	</p>
	<p>
		This is separate from <strong>Excluded chapters</strong> above, which is about reports. Changes take
		effect on the next membership sync, within a day.
	</p>
</ChapterListEditor>

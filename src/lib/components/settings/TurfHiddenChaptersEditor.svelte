<script lang="ts">
	import ChapterListEditor from './ChapterListEditor.svelte';

	interface ChapterOption {
		id: number;
		name: string;
	}

	interface Props {
		/** The chapters /turfs can list: those in the chapter → channel map. */
		chapters: ChapterOption[];
		/** Currently hidden chapter ids from loadSettings. */
		hiddenIds: number[];
	}

	let { chapters, hiddenIds }: Props = $props();
</script>

<ChapterListEditor
	{chapters}
	selectedIds={hiddenIds}
	endpoint="/api/settings/turf-hidden-chapters"
	label="Hidden from /turfs"
	placeholder="Hide a chapter from /turfs…"
>
	<p>
		The <strong>/turfs</strong> page and the Slack <code>/turfs</code> command offer every chapter mapped
		to a Slack channel above. Chapters listed here are left out of both — a link to one opens the chapter
		picker instead — while keeping their Slack channels, their place in the reports, and their VAN folders.
		The organizer and activity pages still list them.
	</p>
	<p>
		Someone already holding turf in a hidden chapter keeps it: the claim runs to its end, and
		<code>/turfs-mine</code> in Slack still shows their list number.
	</p>
</ChapterListEditor>

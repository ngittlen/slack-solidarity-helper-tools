// Pure logic for the chapter ↔ channel multi-editor, extracted from the
// Svelte components (same rationale as picker-logic.ts) so the
// intersection-display and add/remove-diff rules are unit-testable without
// JSDOM.

/**
 * Channels shown in the multi-select when N chapters are selected: only the
 * channels EVERY selected chapter maps to (intersection). Channels that only
 * some selected chapters have stay invisible and untouched by edits.
 * Order follows the first selected chapter's entry order. Empty selection →
 * empty list.
 */
export function sharedChannelIds(
	selectedChapterIds: number[],
	entries: ReadonlyArray<{ chapterId: number; channelId: string }>,
): string[] {
	if (selectedChapterIds.length === 0) return [];

	const byChapter = new Map<number, Set<string>>();
	for (const e of entries) {
		let set = byChapter.get(e.chapterId);
		if (!set) {
			set = new Set();
			byChapter.set(e.chapterId, set);
		}
		set.add(e.channelId);
	}

	const [first, ...rest] = selectedChapterIds;
	const firstSet = byChapter.get(first!);
	if (!firstSet) return [];
	return [...firstSet].filter((channelId) =>
		rest.every((chapterId) => byChapter.get(chapterId)?.has(channelId) ?? false),
	);
}

export interface SelectionDiff {
	added: string[];
	removed: string[];
}

/** Diff two selected-id arrays into the chips that were added and removed. */
export function diffSelection(prev: readonly string[], next: readonly string[]): SelectionDiff {
	const prevSet = new Set(prev);
	const nextSet = new Set(next);
	return {
		added: next.filter((id) => !prevSet.has(id)),
		removed: prev.filter((id) => !nextSet.has(id)),
	};
}

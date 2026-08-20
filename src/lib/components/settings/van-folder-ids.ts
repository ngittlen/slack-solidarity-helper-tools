// Parsing the folder-id box in VanChapterFoldersEditor.
//
// Extracted from the component for the same reason nav-active.ts and
// picker-logic.ts are: the component can't be unit-tested, and this is the part
// with edge cases. Admins paste from VAN, from a spreadsheet, or type by hand,
// so the input arrives with stray spaces, trailing commas, and newlines.

export type ParseResult = { ok: true; folderIds: number[] } | { ok: false; error: string };

/** Accepts commas, whitespace and newlines as separators. Duplicates collapse,
 *  order is normalised ascending, and an empty box is valid — it means "this
 *  chapter has no turf", which is a real thing to say. */
export function parseFolderIds(raw: string): ParseResult {
	const tokens = raw
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter((t) => t !== '');

	const ids: number[] = [];
	for (const token of tokens) {
		// Explicitly reject anything non-numeric rather than letting Number()
		// coerce it: '1152px' becoming NaN and '0x12' becoming 18 are both worse
		// than telling the admin which token was wrong.
		if (!/^\d+$/.test(token)) {
			return { ok: false, error: `"${token}" isn't a folder id — they're whole numbers.` };
		}
		const id = Number(token);
		if (!Number.isSafeInteger(id) || id <= 0) {
			return { ok: false, error: `"${token}" isn't a valid folder id.` };
		}
		ids.push(id);
	}

	return { ok: true, folderIds: [...new Set(ids)].sort((a, b) => a - b) };
}

/** The canonical rendering written back into the box after a successful save,
 *  so the admin sees duplicates collapsed and ordering applied. */
export function formatFolderIds(folderIds: readonly number[]): string {
	return folderIds.join(', ');
}

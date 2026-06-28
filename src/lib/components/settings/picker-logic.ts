// Pure-function picker logic, extracted from AutocompletePicker.svelte so the
// no-free-text-fallthrough guarantee (FR-012, SC-006) is testable without
// standing up JSDOM and Bits UI's portal machinery. The component imports
// these helpers and wires them to its own DOM events.

import type { PickerItem } from './picker-types.js';

export function filterPickerItems<T extends string | number>(
	items: PickerItem<T>[],
	query: string,
): PickerItem<T>[] {
	const q = query.toLowerCase().trim();
	if (q === '') return items;
	return items.filter((i) => {
		if (i.label.toLowerCase().includes(q)) return true;
		return !!(i.sublabel && i.sublabel.toLowerCase().includes(q));

	});
}

export type BlurReconcileResult<T extends string | number> =
	| { accept: true; id: T }
	| { accept: false };

/**
 * On blur, decide whether the current input text matches an item (accept it
 * as the new selection) or doesn't (reject — the component reverts the input
 * to the current selection's label).
 *
 * Match is exact, case-insensitive, against label only. Substring matches
 * are deliberately NOT enough to commit a selection — they're enough to
 * filter the dropdown (filterPickerItems above), but committing without an
 * explicit click/Enter would let "alp" silently save as "alpha", which is
 * the kind of accidental save the no-free-text rule exists to prevent.
 */
export function reconcileBlurInput<T extends string | number>(
	items: PickerItem<T>[],
	inputText: string,
): BlurReconcileResult<T> {
	const trimmed = inputText.trim().toLowerCase();
	if (trimmed === '') return { accept: false };
	const match = items.find((i) => i.label.toLowerCase() === trimmed);
	if (!match) return { accept: false };
	return { accept: true, id: match.id };
}

// Shared types for the autocomplete picker primitive and the upcoming
// editor tickets that compose it. PickerItem is intentionally generic over
// its id type so a Channel picker (id: string) and a Chapter picker (id:
// number) can both use the same component and helpers.

export interface PickerItem<TId extends string | number = string | number> {
	id: TId;
	label: string;
	sublabel?: string;
}

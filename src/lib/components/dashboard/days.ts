export const DASHBOARD_DAYS_PRESETS = [7, 30, 90] as const;
export type DashboardDaysPreset = (typeof DASHBOARD_DAYS_PRESETS)[number];

const DEFAULT_PRESET: DashboardDaysPreset = 7;

export function parseDaysParam(searchParams: URLSearchParams): DashboardDaysPreset {
	const raw = searchParams.get('days');
	if (raw === null || raw === '') return DEFAULT_PRESET;
	const parsed = parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_PRESET;
	let best: DashboardDaysPreset = DASHBOARD_DAYS_PRESETS[0];
	let bestDist = Math.abs(parsed - best);
	for (const preset of DASHBOARD_DAYS_PRESETS) {
		const dist = Math.abs(parsed - preset);
		// Ties bias toward the wider (later) preset.
		if (dist <= bestDist) {
			best = preset;
			bestDist = dist;
		}
	}
	return best;
}

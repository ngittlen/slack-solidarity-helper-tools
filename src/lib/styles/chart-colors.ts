/**
 * Categorical palette for per-chapter chart bands. Single source of truth:
 * consumed directly by SignupChart (layerchart needs literal color strings)
 * and projected onto `:root` as `--chart-band-1..N` by the root layout so CSS
 * can reference the same colors via `var(--chart-band-N)`.
 */
export const CHART_BAND_COLORS = [
	'#233071',
	'#D21214',
	'#406BBF',
	'#E1B682',
	'#CBA16E',
	'#FF564D',
	'#383533',
	'#F5CC9B',
	'#4a5580',
	'#8a94b8',
	'#1e2d70',
	'#d3951e',
] as const;

/** Inline style string projecting the palette onto a wrapper as
 * `--chart-band-N` custom properties, so descendants can `var(--chart-band-1)`. */
export const CHART_BAND_STYLE = CHART_BAND_COLORS.map((c, i) => `--chart-band-${i + 1}: ${c}`).join(
	'; ',
);

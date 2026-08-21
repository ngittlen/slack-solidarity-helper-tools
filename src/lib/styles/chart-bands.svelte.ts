// The categorical chart palette, read from the live theme.
//
// layerchart needs literal colour strings for `series[].color`, not `var()`, so
// this is the one place a colour has to cross from CSS back into JS. Rather
// than threading the palette through page data, it reads the custom properties
// the theme already emitted onto :root — which means the bands follow dark mode
// automatically, and would follow an admin edit too, with no plumbing.
//
// SSR returns the light defaults: there is no document to measure, and the
// chart is client-rendered anyway, so the values are replaced before paint.

import { CHART_BANDS, CHART_BAND_COUNT } from './tokens.js';

function read(): string[] {
	if (typeof document === 'undefined') return [...CHART_BANDS.light];
	const style = getComputedStyle(document.documentElement);
	return Array.from({ length: CHART_BAND_COUNT }, (_, i) => {
		const value = style.getPropertyValue(`--chart-band-${i + 1}`).trim();
		// A missing property means theme injection failed; the light defaults
		// keep the chart readable rather than rendering transparent bars.
		return value || CHART_BANDS.light[i];
	});
}

/**
 * Reactive chart bands. Re-reads when the OS colour scheme flips, so a chart
 * open on screen restyles with everything else instead of keeping light-mode
 * bars on a dark ground.
 */
export function chartBands() {
	const bands = $state({ current: read() });

	$effect(() => {
		bands.current = read();
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = () => (bands.current = read());
		media.addEventListener('change', onChange);
		return () => media.removeEventListener('change', onChange);
	});

	return bands;
}

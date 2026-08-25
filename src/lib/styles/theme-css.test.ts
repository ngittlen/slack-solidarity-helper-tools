import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BRAND, BRAND_KEYS } from './brand.js';
import { TOKENS, TOKEN_KEYS, CHART_BANDS } from './tokens.js';
import {
	CONTRAST_PAIRS,
	contrastRatio,
	contrastWarnings,
	isValidHex,
	luminance,
	OVERRIDABLE_KEYS,
	parseOverrides,
	resolveTheme,
	themeCss,
	WCAG_AA_NORMAL,
} from './theme-css.js';

describe('brand palette', () => {
	it('names colours by role, and keeps the guide name for traceability', () => {
		// The palette is named for what each colour DOES, because that is what an
		// admin editing it needs. The guide's appearance name is kept as data so
		// the mapping back to the PDF survives the rename.
		expect(BRAND.primary.name).toBe('Primary');
		expect(BRAND.primary.guideName).toBe('Deep Blue');
		for (const key of BRAND_KEYS) {
			expect(BRAND[key].name, key).toBeTruthy();
			expect(BRAND[key].guideName, key).toBeTruthy();
		}
	});

	it('states the guide’s printed hex values, not the PDF’s rendered ones', () => {
		// The rendered swatches are #1d2151 / #283270 / #456bb4 / #d22027 — the
		// values the old palette was eyedropped from. These must not come back.
		expect(BRAND.primary.hex).toBe('#1e204e');
		expect(BRAND.secondary.hex).toBe('#2a326c');
		expect(BRAND.accent.hex).toBe('#4e6aae');
		expect(BRAND.danger.hex).toBe('#c13531');
	});

	it('flags FOR US Yellow as video-only and keeps it out of the picker', () => {
		expect(BRAND.video.videoOnly).toBe(true);
		const usedAnywhere = TOKEN_KEYS.some(
			(k) => TOKENS[k].light === BRAND.video.hex || TOKENS[k].dark === BRAND.video.hex,
		);
		expect(usedAnywhere).toBe(false);
	});

	it('uses lowercase six-digit hex throughout', () => {
		for (const c of Object.values(BRAND)) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
	});
});

describe('parseOverrides', () => {
	it('accepts a well-formed override', () => {
		const { config, rejected } = parseOverrides({ 'color-bg': { light: '#ABCDEF' } });
		expect(config.tokens['color-bg']).toEqual({ light: '#abcdef' });
		expect(rejected).toEqual([]);
	});

	it('treats null and undefined as no overrides', () => {
		expect(parseOverrides(null).config.tokens).toEqual({});
		expect(parseOverrides(undefined).config.tokens).toEqual({});
	});

	it('drops unknown keys and reports them', () => {
		const { config, rejected } = parseOverrides({ 'color-nope': { light: '#ffffff' } });
		expect(config.tokens).toEqual({});
		expect(rejected).toContain('color-nope');
	});

	// The injection guard. A shadow or font value is free text, so it is not
	// overridable at all and can never reach the emitted <style>.
	it('refuses non-colour tokens', () => {
		const { config, rejected } = parseOverrides({
			'shadow-card': { light: '0 0 0 red' },
			'color-scrim': { light: 'rgb(0 0 0 / .5)' },
		});
		expect(config.tokens).toEqual({});
		expect(rejected).toEqual(expect.arrayContaining(['shadow-card', 'color-scrim']));
	});

	it('rejects anything that is not #rrggbb', () => {
		for (const bad of ['red', '#fff', '#GGGGGG', 'url(x)', '#ffffff;}', 123, null]) {
			const { config, rejected } = parseOverrides({ 'color-bg': { light: bad } });
			expect(config.tokens['color-bg']).toBeUndefined();
			expect(rejected).toContain('color-bg.light');
		}
	});

	it('keeps a valid mode when its sibling is malformed', () => {
		const { config } = parseOverrides({ 'color-bg': { light: '#000000', dark: 'nope' } });
		expect(config.tokens['color-bg']).toEqual({ light: '#000000' });
	});

	it('survives a corrupt blob without throwing', () => {
		for (const bad of ['a string', 42, [], [1, 2]]) {
			expect(() => parseOverrides(bad)).not.toThrow();
		}
	});
});

describe('resolveTheme', () => {
	it('returns a value for every token in both modes', () => {
		const t = resolveTheme();
		for (const key of TOKEN_KEYS) {
			expect(t.light[key]).toBeTruthy();
			expect(t.dark[key]).toBeTruthy();
		}
	});

	it('layers an override over the default', () => {
		// Compared against the RESOLVED default, not the raw table value — most
		// entries are now '@brandKey' references rather than literals.
		const base = resolveTheme();
		const t = resolveTheme({ tokens: { 'color-bg': { light: '#123456' } } });
		expect(t.light['color-bg']).toBe('#123456');
		expect(t.dark['color-bg']).toBe(base.dark['color-bg']);
	});

	it('lets light be rethemed without touching dark', () => {
		const base = resolveTheme();
		const t = resolveTheme({ tokens: { 'color-text': { light: '#111111' } } });
		expect(t.dark['color-text']).toBe(base.dark['color-text']);
	});
});

describe('themeCss', () => {
	const css = themeCss(resolveTheme());

	it('emits into the theme layer so component styles still win', () => {
		// Preceded by the layer-order statement — see the ordering suite below.
		expect(css).toContain('@layer theme{');
		expect(css.indexOf('@layer theme{')).toBeLessThan(css.indexOf(':root{'));
	});

	it('covers all three viewer states', () => {
		expect(css).toContain('@media (prefers-color-scheme:dark)');
		expect(css).toContain(':root:not([data-theme="light"])');
		expect(css).toContain(':root[data-theme="dark"]');
		expect(css).toContain(':root[data-theme="light"]');
	});

	it('declares color-scheme so form controls and scrollbars follow', () => {
		expect(css).toContain('color-scheme:light');
		expect(css).toContain('color-scheme:dark');
	});

	it('emits every token and every chart band', () => {
		for (const key of TOKEN_KEYS) expect(css).toContain(`--${key}:`);
		for (let i = 1; i <= CHART_BANDS.light.length; i++) {
			expect(css).toContain(`--chart-band-${i}:`);
		}
	});

	it('emits static tokens once, outside the mode blocks', () => {
		expect(css.match(/--font-body:/g)).toHaveLength(1);
		expect(css).toContain('--space-4:');
		expect(css).toContain('--radius-lg:');
	});

	it('cannot be escaped by a stored override', () => {
		// parseOverrides is the gate; this asserts the two work together.
		const { config } = parseOverrides({ 'color-bg': { light: '#fff;}</style><script>x' } });
		const out = themeCss(resolveTheme(config));
		expect(out).not.toContain('<script');
		expect(out).not.toContain('</style');
	});

	it('balances its braces', () => {
		expect((css.match(/{/g) ?? []).length).toBe((css.match(/}/g) ?? []).length);
	});
});

describe('contrast', () => {
	it('is 21 for black on white and 1 for a colour on itself', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
		expect(contrastRatio('#4e6aae', '#4e6aae')).toBeCloseTo(1, 5);
	});

	it('is order-independent', () => {
		expect(contrastRatio('#1e204e', '#fbf0e4')).toBeCloseTo(contrastRatio('#fbf0e4', '#1e204e'), 6);
	});

	it('scores white above black on luminance', () => {
		expect(luminance('#ffffff')).toBeGreaterThan(luminance('#000000'));
		expect(luminance('not-a-colour')).toBe(0);
	});

	// The finding that shaped the dark palette: this pair is on-brand, looks
	// fine as two swatches, and is unreadable as text.
	it('catches Light Blue on Deep Blue as unreadable', () => {
		const ratio = contrastRatio(BRAND.accent.hex, BRAND.primary.hex);
		expect(ratio).toBeLessThan(WCAG_AA_NORMAL);
		expect(ratio).toBeLessThan(3);
	});

	it('passes the shipped defaults in both modes', () => {
		expect(contrastWarnings(resolveTheme())).toEqual([]);
	});

	it('reports a mode and ratio when an admin breaks a pair', () => {
		const warnings = contrastWarnings(
			resolveTheme({ tokens: { 'color-text': { light: '#fbf0e4' } } }),
		);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0].mode).toBe('light');
		expect(warnings[0].ratio).toBeLessThan(WCAG_AA_NORMAL);
	});

	it('only checks pairs that are real tokens', () => {
		for (const [fg, bg] of CONTRAST_PAIRS) {
			expect(TOKEN_KEYS).toContain(fg);
			expect(TOKEN_KEYS).toContain(bg);
		}
	});
});

describe('editor surface', () => {
	it('offers every colour token and no raw ones', () => {
		expect(OVERRIDABLE_KEYS).toContain('color-bg');
		expect(OVERRIDABLE_KEYS).toContain('led-panel');
		expect(OVERRIDABLE_KEYS).not.toContain('shadow-card');
		expect(OVERRIDABLE_KEYS).not.toContain('color-scrim');
	});

	it('gives every token a label and a group', () => {
		for (const key of TOKEN_KEYS) {
			expect(TOKENS[key].label.length).toBeGreaterThan(0);
			expect(TOKENS[key].group).toBeTruthy();
		}
	});

	it('validates hex the same way the picker will', () => {
		expect(isValidHex('#aabbcc')).toBe(true);
		expect(isValidHex('#AABBCC')).toBe(true);
		expect(isValidHex('#abc')).toBe(false);
	});
});

describe('cascade layer ordering', () => {
	const css = themeCss(resolveTheme());

	// The bug this guards: the theme is injected into <head> BEFORE app.css, and
	// the browser fixes layer order from the first @layer statement it sees. If
	// this stylesheet opened with `@layer theme{`, `theme` would become layer #1
	// and app.css's later declaration would append `fallback` ABOVE it — so the
	// few tokens the fallback defines render light while the rest render dark.
	it('states the full layer order before opening the theme layer', () => {
		const order = css.indexOf('@layer fallback,reset,theme,base,components,utilities;');
		const open = css.indexOf('@layer theme{');
		expect(order).toBe(0);
		expect(order).toBeLessThan(open);
	});

	it('matches the order app.css declares', () => {
		const appCss = readFileSync('src/app.css', 'utf8');
		const declared = /@layer ([a-z,\s]+);/.exec(appCss)?.[1].replace(/\s/g, '');
		expect(declared).toBe('fallback,reset,theme,base,components,utilities');
	});

	// A viewer on a dark OS looking at the light theme must get light form
	// controls; `color-scheme: light dark` would give them dark ones.
	it('declares color-scheme per mode, never both', () => {
		expect(css).not.toContain('color-scheme:light dark');
		expect(css).toContain(':root{color-scheme:light;');
		expect(css).toContain('color-scheme:dark');
	});

	it('gives the fallback layer every token that could otherwise split the page', () => {
		// A partial fallback is what produced the half-light/half-dark render:
		// tokens it defines won, tokens it omitted did not. Any colour token the
		// fallback defines is fine; the hazard is defining SOME surface tokens
		// and not their neighbours.
		const appCss = readFileSync('src/app.css', 'utf8');
		const block = appCss.slice(appCss.indexOf('@layer fallback'), appCss.indexOf('@layer reset'));
		for (const required of [
			'--color-bg:',
			'--color-surface:',
			'--color-bg-surface:',
			'--color-cream-light:',
			'--color-text:',
			'--color-border:',
		]) {
			expect(block).toContain(required);
		}
	});
});

describe('surface stacking', () => {
	// The settings rail is chrome: it should sit between the page and a card in
	// BOTH modes. Getting this backwards in dark mode makes the rail look like
	// it floats above the content it is supposed to sit behind.
	it('keeps chrome between the page and cards in both modes', () => {
		const t = resolveTheme();
		for (const mode of ['light', 'dark'] as const) {
			const page = luminance(t[mode]['color-bg']);
			const chrome = luminance(t[mode]['color-cream-light']);
			const card = luminance(t[mode]['color-surface']);
			expect(page, `${mode}: page vs chrome`).toBeLessThan(chrome);
			expect(chrome, `${mode}: chrome vs card`).toBeLessThan(card);
		}
	});
});

describe('brand palette as a source', () => {
	it('every @ref in the token table points at a real brand colour', () => {
		for (const key of TOKEN_KEYS) {
			for (const mode of ['light', 'dark'] as const) {
				const raw = TOKENS[key][mode];
				if (!raw.startsWith('@')) continue;
				expect(BRAND_KEYS, `${key}.${mode} -> ${raw}`).toContain(raw.slice(1));
			}
		}
	});

	// The point of the whole refactor: the palette is a source, not a swatch list.
	it('cascades a palette edit to every token derived from it', () => {
		const before = resolveTheme();
		const after = resolveTheme({ brand: { primary: '#003300' } });

		// Deep Blue backs body text, the header, the primary action and the focus
		// ring in light mode — all four should move together.
		for (const key of [
			'color-text',
			'color-header-bg',
			'color-action',
			'color-border-focus',
		] as const) {
			expect(before.light[key]).toBe(BRAND.primary.hex);
			expect(after.light[key]).toBe('#003300');
		}
		// ...and the dark page background, which is the same brand colour.
		expect(after.dark['color-bg']).toBe('#003300');
	});

	it('leaves tokens that do not reference it alone', () => {
		const after = resolveTheme({ brand: { primary: '#003300' } });
		expect(after.light['color-surface']).toBe('#ffffff');
		expect(after.light['led-panel']).toBe('#07070a');
	});

	it('lets an explicit token override beat the palette', () => {
		const t = resolveTheme({
			brand: { primary: '#003300' },
			tokens: { 'color-text': { light: '#abcdef' } },
		});
		expect(t.light['color-text']).toBe('#abcdef');
		// Its siblings still follow the palette.
		expect(t.light['color-action']).toBe('#003300');
	});

	it('cascades into the chart bands too', () => {
		const after = resolveTheme({ brand: { secondary: '#010203' } });
		expect(after.chartBands.light[0]).toBe('#010203');
	});

	it('exposes the palette in force for the editor', () => {
		expect(resolveTheme().palette.paper).toBe(BRAND.paper.hex);
		expect(resolveTheme({ brand: { paper: '#fefefe' } }).palette.paper).toBe('#fefefe');
	});

	it('validates brand overrides and reports bad ones', () => {
		const { config, rejected } = parseOverrides({
			brand: { primary: '#001122', nope: '#ffffff', cream: 'not-a-hex' },
		});
		expect(config.brand).toEqual({ primary: '#001122' });
		expect(rejected).toEqual(expect.arrayContaining(['brand.nope', 'brand.cream']));
	});

	// The stored column predates the palette layer; a flat blob must still load.
	it('reads a legacy flat token blob', () => {
		const { config } = parseOverrides({ 'color-bg': { light: '#123456' } });
		expect(config.tokens['color-bg']).toEqual({ light: '#123456' });
		expect(config.brand).toEqual({});
	});

	it('round-trips a layered blob', () => {
		const input = { brand: { paper: '#fefefe' }, tokens: { 'color-bg': { dark: '#010101' } } };
		const { config, rejected } = parseOverrides(input);
		expect(rejected).toEqual([]);
		expect(config).toEqual(input);
	});

	it('still passes contrast with the shipped palette', () => {
		expect(contrastWarnings(resolveTheme())).toEqual([]);
	});
});

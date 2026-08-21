// Turning token definitions + admin overrides into the CSS the page ships.
//
// Pure: no DB, no env, no globals. The server calls `themeCss(resolveTheme(x))`
// and injects the result; the settings editor calls the same pair on unsaved
// draft values to render a live preview. One code path, so what an admin
// previews is exactly what will ship.
//
// SECURITY: every overridable value is validated against /^#[0-9a-f]{6}$/ and
// rejected otherwise. Non-colour tokens (shadows, the scrim, fonts) are NOT
// overridable, which means no admin-supplied string can ever reach the emitted
// stylesheet unescaped. That is deliberate — a free-text CSS value in a <style>
// block is a script-injection vector, and no theming benefit is worth it.

import {
	BRAND_KEYS,
	derefBrand,
	resolveBrand,
	type BrandColorKey,
	type BrandOverrides,
} from './brand.js';
import { CHART_BANDS, STATIC_TOKENS, TOKENS, TOKEN_KEYS, type TokenKey } from './tokens.js';

export type Mode = 'light' | 'dark';
export type ThemeOverrides = Partial<Record<TokenKey, Partial<Record<Mode, string>>>>;

/**
 * Everything an admin can change, in one stored object.
 *
 * Two layers, and the order matters. `brand` redefines the palette itself, so a
 * change there moves every token whose default is a `@ref`. `tokens` overrides
 * an individual token outright, and wins over whatever the palette says — that
 * is what lets someone retheme one surface without disturbing the rest.
 */
export interface ThemeConfig {
	brand: BrandOverrides;
	tokens: ThemeOverrides;
}

export const EMPTY_CONFIG: ThemeConfig = { brand: {}, tokens: {} };

const HEX = /^#[0-9a-f]{6}$/;

export function isValidHex(value: unknown): value is string {
	return typeof value === 'string' && HEX.test(value.trim().toLowerCase());
}

/** Tokens an admin may change: colour-valued ones that aren't locked. */
export function isOverridable(key: TokenKey): boolean {
	const def = TOKENS[key];
	return !def.locked && (def.kind ?? 'color') === 'color';
}

export const OVERRIDABLE_KEYS: TokenKey[] = TOKEN_KEYS.filter(isOverridable);

export interface ParseResult {
	config: ThemeConfig;
	/** Keys that were dropped, so a save can report rather than silently discard. */
	rejected: string[];
}

/**
 * Validate an untrusted overrides object (a parsed JSON column, or a request
 * body). Unknown keys, non-overridable keys and malformed values are dropped
 * and reported rather than throwing — a single bad key in a stored blob must
 * not take the whole site's theme down with it.
 */
export function parseOverrides(raw: unknown): ParseResult {
	const tokens: ThemeOverrides = {};
	const brand: BrandOverrides = {};
	const rejected: string[] = [];

	if (raw === null || raw === undefined) return { config: { brand, tokens }, rejected };
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		return { config: { brand, tokens }, rejected: ['(root)'] };
	}

	const obj = raw as Record<string, unknown>;
	// A stored blob written before the palette became editable is a flat map of
	// token keys. Treat it as the `tokens` layer rather than rejecting it.
	const isLayered = 'brand' in obj || 'tokens' in obj;
	const tokenSource = (isLayered ? obj.tokens : obj) ?? {};
	const brandSource = (isLayered ? obj.brand : {}) ?? {};

	if (typeof brandSource === 'object' && brandSource !== null && !Array.isArray(brandSource)) {
		for (const [key, value] of Object.entries(brandSource as Record<string, unknown>)) {
			if (!BRAND_KEYS.includes(key as BrandColorKey)) {
				rejected.push(`brand.${key}`);
				continue;
			}
			if (!isValidHex(value)) {
				rejected.push(`brand.${key}`);
				continue;
			}
			brand[key as BrandColorKey] = value.trim().toLowerCase();
		}
	} else {
		rejected.push('brand');
	}

	if (typeof tokenSource === 'object' && tokenSource !== null && !Array.isArray(tokenSource)) {
		for (const [key, value] of Object.entries(tokenSource as Record<string, unknown>)) {
			if (!(key in TOKENS) || !isOverridable(key as TokenKey)) {
				rejected.push(key);
				continue;
			}
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				rejected.push(key);
				continue;
			}
			const entry: Partial<Record<Mode, string>> = {};
			for (const mode of ['light', 'dark'] as const) {
				const v = (value as Record<string, unknown>)[mode];
				if (v === undefined) continue;
				if (!isValidHex(v)) {
					rejected.push(`${key}.${mode}`);
					continue;
				}
				entry[mode] = v.trim().toLowerCase();
			}
			if (Object.keys(entry).length > 0) tokens[key as TokenKey] = entry;
		}
	} else {
		rejected.push('tokens');
	}

	return { config: { brand, tokens }, rejected };
}

export interface ResolvedTheme {
	light: Record<string, string>;
	dark: Record<string, string>;
	chartBands: { light: readonly string[]; dark: readonly string[] };
	/** The palette in force, for the editor's brand rows. */
	palette: Record<BrandColorKey, string>;
}

/**
 * Build the theme.
 *
 * Order is the whole design: resolve the palette, dereference each token's
 * `@brandKey` default against it, then let an explicit token override win. So
 * editing Deep Blue moves body text, the header, the focus ring and the primary
 * action together — while a token someone has set by hand stays put.
 */
export function resolveTheme(config: Partial<ThemeConfig> = {}): ResolvedTheme {
	const palette = resolveBrand(config.brand ?? {});
	const overrides = config.tokens ?? {};

	const light: Record<string, string> = {};
	const dark: Record<string, string> = {};

	for (const key of TOKEN_KEYS) {
		const def = TOKENS[key];
		const over = overrides[key];
		light[key] = over?.light ?? derefBrand(def.light, palette);
		dark[key] = over?.dark ?? derefBrand(def.dark, palette);
	}

	return {
		light,
		dark,
		palette,
		chartBands: {
			light: CHART_BANDS.light.map((c) => derefBrand(c, palette)),
			dark: CHART_BANDS.dark.map((c) => derefBrand(c, palette)),
		},
	};
}

function declarations(vars: Record<string, string>, bands: readonly string[]): string {
	const parts = Object.entries(vars).map(([k, v]) => `--${k}:${v}`);
	bands.forEach((c, i) => parts.push(`--chart-band-${i + 1}:${c}`));
	return parts.join(';');
}

/**
 * The stylesheet text, emitted into the `theme` cascade layer that app.css
 * already declares but never fills. Being below `base` and `components` means
 * component styles keep winning, so this can never fight a rule someone wrote.
 *
 * Three blocks, because the viewer has three states and not two: an explicit
 * light choice must beat a dark OS setting, and an explicit dark choice must
 * beat a light one. The default (no attribute) follows the OS.
 */
export function themeCss(theme: ResolvedTheme): string {
	const staticVars = Object.entries(STATIC_TOKENS)
		.map(([k, v]) => `--${k}:${v}`)
		.join(';');

	const lightDecls = declarations(theme.light, theme.chartBands.light);
	const darkDecls = declarations(theme.dark, theme.chartBands.dark);

	return [
		// The layer order MUST be restated here, and first.
		//
		// The browser fixes layer order from the first @layer statement it sees.
		// This stylesheet is injected into <head> ahead of app.css, so without
		// this line `theme` would be registered as layer #1 and app.css's later
		// `@layer fallback, reset, theme, …` would append the rest AFTER it —
		// leaving `fallback` outranking `theme`. The symptom is a page where the
		// handful of tokens the fallback defines render light while every other
		// token renders dark. Restating the identical order makes whichever
		// stylesheet lands first agree with the other.
		'@layer fallback,reset,theme,base,components,utilities;',
		'@layer theme{',
		// color-scheme is per-mode, not `light dark`. It tells the browser how to
		// paint form controls and scrollbars; declaring both means a viewer whose
		// OS is dark gets dark <input>s even when they are looking at the light
		// theme.
		`:root{color-scheme:light;${staticVars};${lightDecls}}`,
		`@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${darkDecls}}}`,
		`:root[data-theme="dark"]{color-scheme:dark;${darkDecls}}`,
		`:root[data-theme="light"]{color-scheme:light;${lightDecls}}`,
		'}',
	].join('');
}

/**
 * One mode's declarations as an inline `style` string.
 *
 * The settings editor previews unsaved values by applying this to a wrapper —
 * same resolver, same token names, so what the preview shows is what the page
 * will ship. `themeCss` can't be reused there because it emits `:root` rules
 * inside a cascade layer, which an element cannot scope to itself.
 */
export function themeInlineStyle(theme: ResolvedTheme, mode: Mode): string {
	const bands = theme.chartBands[mode];
	return declarations(theme[mode], bands);
}

// --- Contrast ------------------------------------------------------------
// WCAG 2.1 relative luminance. Used by the editor to warn when a hand-picked
// pair becomes unreadable — the trap being Light Blue on Deep Blue, which is
// on-brand, looks plausible in a swatch, and is about 2:1.

function channel(c: number): number {
	const s = c / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
	const h = hex.trim().toLowerCase();
	if (!HEX.test(h)) return 0;
	const r = parseInt(h.slice(1, 3), 16);
	const g = parseInt(h.slice(3, 5), 16);
	const b = parseInt(h.slice(5, 7), 16);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1–21. Order of arguments doesn't matter. */
export function contrastRatio(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

export const WCAG_AA_NORMAL = 4.5;
export const WCAG_AA_LARGE = 3;

/** Pairs the editor checks. Each is (foreground, background) by token key. */
export const CONTRAST_PAIRS: readonly (readonly [TokenKey, TokenKey])[] = [
	['color-text', 'color-bg'],
	['color-text', 'color-surface'],
	['color-text-muted', 'color-bg'],
	['color-text-muted', 'color-surface'],
	['color-action-text', 'color-action'],
	['color-header-text', 'color-header-bg'],
	['color-error', 'color-surface'],
	['color-success', 'color-surface'],
	['color-warning', 'color-surface'],
];

export interface ContrastWarning {
	pair: readonly [TokenKey, TokenKey];
	mode: Mode;
	ratio: number;
}

/** Every pair below AA, in both modes. Empty means the theme is readable. */
export function contrastWarnings(theme: ResolvedTheme): ContrastWarning[] {
	const out: ContrastWarning[] = [];
	for (const mode of ['light', 'dark'] as const) {
		const vars = theme[mode];
		for (const pair of CONTRAST_PAIRS) {
			const [fg, bg] = pair;
			const ratio = contrastRatio(vars[fg], vars[bg]);
			if (ratio < WCAG_AA_NORMAL) out.push({ pair, mode, ratio: Math.round(ratio * 100) / 100 });
		}
	}
	return out;
}

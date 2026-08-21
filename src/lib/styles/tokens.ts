// Every themeable value in the app, with a light and a dark value.
//
// This is the single source of truth. `theme-css.ts` turns it into CSS custom
// properties, the settings editor turns it into rows, and nothing else should
// contain a colour.
//
// Dark values are drawn from the same 13-colour brand palette — the guide's
// "COLOR APPLIED" page shows Deep Blue and Black grounds with Cream text, which
// is exactly the dark theme. One constraint discovered while checking contrast:
// Light Blue (#4e6aae) on Deep Blue (#1e204e) is about 2:1, far below readable,
// so dark-mode actions use the beiges instead of the blues. That is the class of
// mistake the editor's contrast warning exists to catch.

import { FONT_STACKS, type BrandRef } from './brand.js';

export type TokenGroup =
	'surface' | 'text' | 'action' | 'status' | 'accent' | 'chart' | 'led' | 'effect';

export interface TokenDef {
	/** Human label for the settings editor. */
	readonly label: string;
	readonly group: TokenGroup;
	/** Either a literal ('#ffffff') or a brand reference ('@primary').
	 *  References are resolved at theme-build time, so editing the palette moves
	 *  every token derived from it. */
	readonly light: BrandRef | string;
	readonly dark: BrandRef | string;
	/** Colour tokens get a picker; shadows and fonts get a text field. */
	readonly kind?: 'color' | 'raw';
	/** Suppressed from the editor entirely — changing it breaks something. */
	readonly locked?: true;
	readonly note?: string;
}

const TOKEN_DEFS = {
	// --- Surfaces ---------------------------------------------------------
	'color-bg': {
		label: 'Page background',
		group: 'surface',
		light: '@paper',
		dark: '@primary',
	},
	'color-surface': {
		label: 'Card surface',
		group: 'surface',
		light: '#ffffff',
		dark: '@secondary',
		note: 'White is a neutral, not a brand colour — cards need to lift off the cream ground.',
	},
	'color-surface-alt': {
		label: 'Recessed surface',
		group: 'surface',
		light: '@paperLight',
		dark: '#252a5c',
	},
	// Alias kept because ~10 components already reference it. Previously
	// undefined, so every one of them silently rendered a hardcoded #fff.
	'color-bg-surface': {
		label: 'Card surface (alias)',
		group: 'surface',
		light: '#ffffff',
		dark: '@secondary',
	},
	'color-bg-hover': { label: 'Row hover', group: 'surface', light: '#f3e6d6', dark: '#333c7d' },
	'color-border': { label: 'Border', group: 'surface', light: '#ddccb8', dark: '#3c4587' },
	'color-border-subtle': {
		label: 'Subtle border',
		group: 'surface',
		light: '#eee2d2',
		dark: '#2f3873',
	},

	// --- Text -------------------------------------------------------------
	'color-text': { label: 'Body text', group: 'text', light: '@primary', dark: '@paper' },
	'color-text-muted': { label: 'Muted text', group: 'text', light: '#4a5075', dark: '#c3c8e0' },
	'color-text-faint': { label: 'Faint text', group: 'text', light: '#8286a3', dark: '#8f96bb' },
	'color-header-bg': {
		label: 'Header background',
		group: 'text',
		light: '@primary',
		dark: '@ink',
	},
	'color-header-text': {
		label: 'Header text',
		group: 'text',
		light: '@paper',
		dark: '@paper',
	},

	// --- Actions ----------------------------------------------------------
	'color-action': {
		label: 'Primary action',
		group: 'action',
		light: '@primary',
		dark: '@warm',
		note: 'Dark uses beige, not blue: Light Blue on Deep Blue is ~2:1 and unreadable.',
	},
	'color-action-hover': {
		label: 'Action hover',
		group: 'action',
		light: '@secondary',
		dark: '@warmSoft',
	},
	'color-action-text': {
		label: 'Text on action',
		group: 'action',
		light: '@paper',
		dark: '@primary',
	},
	'color-border-focus': {
		label: 'Focus ring',
		group: 'action',
		light: '@primary',
		dark: '@warm',
	},

	// --- Status -----------------------------------------------------------
	'color-error': {
		label: 'Error',
		group: 'status',
		light: '@danger',
		dark: '#ff8a84',
		note: 'Dark is a lightened coral: Coral Red itself is 3.78:1 on Medium Blue, under AA.',
	},
	'color-success': {
		label: 'Success',
		group: 'status',
		light: '#1c7c47',
		dark: '#4ecb87',
		note: 'The brand supplies no green; this is functional, not brand. Darker than the old #27ae60, which was only 2.87:1 on white — it failed AA as text and always had.',
	},
	'color-success-muted': {
		label: 'Success muted',
		group: 'status',
		light: '#90d4aa',
		dark: '#2f7a52',
	},
	'color-warning': {
		label: 'Warning',
		group: 'status',
		light: '#96670f',
		dark: '@warm',
		note: 'Functional amber; the brand has none (FOR US Yellow is video-only). Darker than the old #d3951e, which was 2.6:1 on white. For amber FILLS rather than text, use color-mix over this token.',
	},

	// --- Brand accents ----------------------------------------------------
	'color-navy-mid': {
		label: 'Medium Blue',
		group: 'accent',
		light: '@secondary',
		dark: '@accent',
	},
	'color-blue': { label: 'Light Blue', group: 'accent', light: '@accent', dark: '#7f9bd8' },
	'color-cream-light': {
		label: 'Light Cream',
		group: 'accent',
		light: '@paperLight',
		dark: '#242a5c',
		note: 'Chrome that sits between the page and a card — the settings rail uses it. The dark value must stay BETWEEN --color-bg and --color-surface, or the rail reads as floating above the cards instead of sitting behind them.',
	},
	'color-gold-light': {
		label: 'Light Beige',
		group: 'accent',
		light: '@warmSoft',
		dark: '@warmSoft',
	},
	'color-gold': {
		label: 'Medium Beige',
		group: 'accent',
		light: '@warm',
		dark: '@warm',
	},
	'color-gold-dark': {
		label: 'Dark Beige',
		group: 'accent',
		light: '@warmDeep',
		dark: '@warmDeep',
	},
	'color-near-black': { label: 'Black', group: 'accent', light: '@ink', dark: '@ink' },
	'color-warm-dark': { label: 'Charcoal', group: 'accent', light: '@neutral', dark: '#cfc8c2' },
	'color-coral': {
		label: 'Coral Red',
		group: 'accent',
		light: '@highlight',
		dark: '@highlight',
	},
	'color-red': { label: 'Red', group: 'accent', light: '@danger', dark: '@highlight' },

	// --- Effects ----------------------------------------------------------
	'color-scrim': {
		label: 'Modal scrim',
		group: 'effect',
		light: 'rgb(20 19 18 / 0.45)',
		dark: 'rgb(0 0 0 / 0.6)',
		kind: 'raw',
	},
	'shadow-card': {
		label: 'Card shadow',
		group: 'effect',
		light: '0 1px 2px rgb(30 32 78 / 0.06)',
		dark: '0 1px 2px rgb(0 0 0 / 0.4)',
		kind: 'raw',
	},
	'shadow-popover': {
		label: 'Popover shadow',
		group: 'effect',
		light: '0 4px 12px rgb(30 32 78 / 0.12)',
		dark: '0 4px 12px rgb(0 0 0 / 0.5)',
		kind: 'raw',
	},
	'shadow-modal': {
		label: 'Modal shadow',
		group: 'effect',
		light: '0 8px 32px rgb(30 32 78 / 0.2)',
		dark: '0 8px 32px rgb(0 0 0 / 0.6)',
		kind: 'raw',
	},

	// --- LED board --------------------------------------------------------
	// A physical simulation, not brand colour. The panel value appears in three
	// places that must match exactly (board background, diode grid gradient,
	// ticker edge fade) or the illusion breaks — which is why it is one token.
	'led-panel': { label: 'Panel', group: 'led', light: '#07070a', dark: '#07070a', kind: 'color' },
	'led-bezel': { label: 'Bezel', group: 'led', light: '#26262e', dark: '#26262e', kind: 'color' },
	'led-amber': { label: 'Amber', group: 'led', light: '#ffb02e', dark: '#ffb02e', kind: 'color' },
	'led-amber-dim': {
		label: 'Amber dim',
		group: 'led',
		light: '#9c6a15',
		dark: '#9c6a15',
		kind: 'color',
	},
	'led-amber-lead': {
		label: 'Amber lead',
		group: 'led',
		light: '#ffd98a',
		dark: '#ffd98a',
		kind: 'color',
	},
	'led-green': { label: 'Green', group: 'led', light: '#3dff85', dark: '#3dff85', kind: 'color' },
	'led-green-dim': {
		label: 'Green dim',
		group: 'led',
		light: '#1f8a4a',
		dark: '#1f8a4a',
		kind: 'color',
	},
	'led-red': { label: 'Red', group: 'led', light: '#ff3b31', dark: '#ff3b31', kind: 'color' },
	'led-white': {
		label: 'Cool white',
		group: 'led',
		light: '#eaf2ff',
		dark: '#eaf2ff',
		kind: 'color',
	},
	'led-white-dim': {
		label: 'Cool white dim',
		group: 'led',
		light: '#b9cfe8',
		dark: '#b9cfe8',
		kind: 'color',
	},
	'led-blue-grey': {
		label: 'Blue grey',
		group: 'led',
		light: '#8fa9c9',
		dark: '#8fa9c9',
		kind: 'color',
	},
} as const satisfies Record<string, TokenDef>;

export type TokenKey = keyof typeof TOKEN_DEFS;

/** Widened to `TokenDef` on the way out.
 *
 *  `as const satisfies` checks the literals against the interface but leaves the
 *  inferred type as the literal object, so `TOKENS[k].kind` would be an error on
 *  every entry that happens to omit it. Re-exporting through the interface keeps
 *  the key literals (and therefore `TokenKey`) while making every entry a full
 *  `TokenDef` to read. */
export const TOKENS: Record<TokenKey, TokenDef> = TOKEN_DEFS;
export const TOKEN_KEYS = Object.keys(TOKENS) as TokenKey[];

/**
 * Categorical chart bands.
 *
 * Separate from TOKENS because layerchart needs literal strings in JS, not
 * `var()` — so these are both emitted as custom properties AND threaded to
 * SignupChart through page data. They echo the accent palette deliberately.
 */
export const CHART_BANDS = {
	light: [
		'@secondary',
		'@danger',
		'@accent',
		'@warm',
		'@warmDeep',
		'@highlight',
		'@neutral',
		'@warmSoft',
		'#4a5075',
		'#8286a3',
		'@primary',
		'#d3951e',
	],
	dark: [
		'#7f9bd8',
		'@highlight',
		'@accent',
		'@warm',
		'@warmDeep',
		'#ff8a84',
		'#cfc8c2',
		'@warmSoft',
		'#c3c8e0',
		'#8f96bb',
		'#a8b6e8',
		'#e1b682',
	],
} as const;

export const CHART_BAND_COUNT = CHART_BANDS.light.length;

/** Non-themeable values. Emitted with the theme so everything lives in one
 *  place, but absent from the editor. */
export const STATIC_TOKENS = {
	'font-display': FONT_STACKS.display,
	'font-body': FONT_STACKS.body,
	'font-mono': FONT_STACKS.mono,
	'font-led': FONT_STACKS.led,
	/** Legacy alias — app.css and one route still say var(--font-family). */
	'font-family': FONT_STACKS.body,

	'font-size-xs': '0.7rem',
	'font-size-sm': '0.8rem',
	'font-size-base': '0.85rem',
	'font-size-md': '0.9rem',
	'font-size-lg': '0.95rem',

	'tracking-headline': '0.05em',
	'tracking-subhead': '0.1em',

	'space-1': '4px',
	'space-2': '8px',
	'space-3': '12px',
	'space-4': '16px',
	'space-5': '24px',
	'space-6': '32px',
	'space-7': '48px',

	'radius-sm': '4px',
	'radius-md': '6px',
	'radius-lg': '8px',
} as const;

// The Abdul for US brand palette, transcribed from
// private/AfS-BrandGuide-Refresh-Final-1.pdf (Creative Style Guide 2026, p5).
//
// These hex values are the ones the guide PRINTS next to each swatch, not the
// ones you get by eyedropping the PDF. That distinction matters: the document's
// working colour space renders Deep Blue as #1D2151, Medium Blue as #283270,
// Light Blue as #456BB4 and Red as #D22027 — and the app's original palette was
// clearly sampled that way, which is why it drifted off-brand by a few points
// on four colours. The printed HEX is authoritative.
//
// Nothing outside this file and tokens.ts should contain a colour literal.

export interface BrandColor {
	/** Role name — what the colour is FOR. This is what the editor shows and
	 *  what token defaults reference ('@primary'). */
	readonly name: string;
	/** The appearance name the printed guide uses ('Deep Blue'). Kept so the
	 *  mapping back to the PDF is not lost, and so anyone reconciling the two
	 *  has it in one place. Not shown in the UI by design — the roles are what
	 *  an admin needs; add it as sub-text here if that ever changes. */
	readonly guideName: string;
	readonly hex: string;
	/** The guide marks FOR US Yellow "VIDEO USE ONLY". Flagged rather than
	 *  omitted, so the editor can explain why it isn't offered. */
	readonly videoOnly?: true;
}

const BRAND_DEFS = {
	primary: { name: 'Primary', guideName: 'Deep Blue', hex: '#1e204e' },
	secondary: { name: 'Secondary', guideName: 'Medium Blue', hex: '#2a326c' },
	accent: { name: 'Accent', guideName: 'Light Blue', hex: '#4e6aae' },
	highlight: { name: 'Highlight', guideName: 'Coral Red', hex: '#ff564d' },
	danger: { name: 'Danger', guideName: 'Red', hex: '#c13531' },
	warmDeep: { name: 'Warm deep', guideName: 'Dark Beige', hex: '#cba16e' },
	warm: { name: 'Warm', guideName: 'Medium Beige', hex: '#e1b682' },
	warmSoft: { name: 'Warm soft', guideName: 'Light Beige', hex: '#f5cd9c' },
	paperLight: { name: 'Paper light', guideName: 'Light Cream', hex: '#fdf5ed' },
	paper: { name: 'Paper', guideName: 'Cream', hex: '#fbf0e4' },
	neutral: { name: 'Neutral', guideName: 'Charcoal', hex: '#383533' },
	ink: { name: 'Ink', guideName: 'Black', hex: '#141312' },
	video: { name: 'Video accent', guideName: 'FOR US Yellow', hex: '#f2c127', videoOnly: true },
} as const satisfies Record<string, BrandColor>;

export type BrandColorKey = keyof typeof BRAND_DEFS;

/** Widened to `BrandColor` on the way out — `as const satisfies` checks the
 *  literals but leaves the inferred type as the literal object, so
 *  `BRAND[k].videoOnly` would be an error on the twelve entries that omit it. */
export const BRAND: Record<BrandColorKey, BrandColor> = BRAND_DEFS;

export const BRAND_KEYS = Object.keys(BRAND) as BrandColorKey[];

/**
 * A token default that points at a brand colour rather than restating its hex.
 *
 * This is what makes the palette a real source of truth instead of a swatch
 * list: `--color-action` says "@primary", so changing Primary in settings moves
 * every token derived from it at once. A token that has its own override still
 * wins — see resolveTheme.
 */
export type BrandRef = `@${BrandColorKey}`;

export function isBrandRef(value: string): value is BrandRef {
	return value.startsWith('@') && value.slice(1) in BRAND;
}

/** Admin overrides of the palette itself, keyed by brand colour. */
export type BrandOverrides = Partial<Record<BrandColorKey, string>>;

/** The palette in force: guide defaults with any overrides layered on. */
export function resolveBrand(overrides: BrandOverrides = {}): Record<BrandColorKey, string> {
	const out = {} as Record<BrandColorKey, string>;
	for (const key of BRAND_KEYS) out[key] = overrides[key] ?? BRAND[key].hex;
	return out;
}

/** Resolve one token value: a `@brandKey` reference, or a literal left alone. */
export function derefBrand(value: string, palette: Record<BrandColorKey, string>): string {
	return isBrandRef(value) ? palette[value.slice(1) as BrandColorKey] : value;
}

/** Type stacks.
 *
 *  The guide specifies Kensington (Fort Foundry) for display and Halyard Text
 *  (Darden Studio) for body. Both are Adobe Fonts, which cannot be self-hosted
 *  — using them needs a Typekit web project tied to an Adobe subscription with
 *  the campaign's domain allowlisted.
 *
 *  Until that exists we ship metrically-similar OFL substitutes, self-hosted
 *  the same way Silkscreen already is. Kensington is a narrow, compressed sans
 *  used in all-caps headlines, so Oswald stands in; Halyard is a humanist text
 *  face, so Source Sans 3 does. They approximate, they do not match.
 *
 *  Swapping to the real faces later means adding the Typekit <link> and putting
 *  'kensington' / 'halyard-text' at the front of these two stacks. Nothing else
 *  moves. */
export const FONT_STACKS = {
	/** Headlines. All-caps per the guide — see the `.display` rules in app.css. */
	display: "'Oswald', 'Kensington', 'Arial Narrow', system-ui, sans-serif",
	/** Body copy and UI. */
	body: "'Source Sans 3', 'Halyard Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
	mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
	/** The LED board's bitmap face. NOT admin-editable: LedBoard requires the
	 *  glyph pixel to equal the diode pitch exactly or the ticker moirés. */
	led: "'Silkscreen', 'Courier New', monospace",
} as const;

/** Letter-spacing the guide calls "tracking 5" and "tracking 10". Illustrator
 *  tracking is thousandths of an em, so 5 → 0.005em… but the guide's headline
 *  samples are set far looser than that reads on screen at UI sizes. These are
 *  the values that match the printed samples optically. */
export const TRACKING = {
	headline: '0.05em',
	subhead: '0.1em',
} as const;

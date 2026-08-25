import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN_KEYS } from './tokens.js';

// Guards the two failure modes this design system was built to end.
//
// Before it, ~150 declarations said `var(--color-gold, #b8860b)` against a real
// token value of #e1b682, and four tokens (--color-bg-surface, --color-bg-hover,
// --color-surface-alt, --color-danger) were referenced everywhere but defined
// nowhere — so those rules silently rendered hardcoded light-mode colours that
// no theme could touch. Both classes are invisible until someone turns on dark
// mode and finds islands of the wrong palette.

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.(svelte|css)$/.test(name)) out.push(p);
	}
	return out;
}

const FILES = walk('src').filter((f) => !f.endsWith('app.css'));

/** The LED board is a physical simulation, not brand colour: its diode glows are
 *  hand-tuned warmer/cooler than their base and must stay literal. */
const LED_FILES = /dashboard\/(LedBoard|DoorTicker|CountdownBanner)\.svelte$/;

/** Set at runtime rather than in a stylesheet — by bits-ui, or by an inline
 *  style attribute the ticker computes. */
const RUNTIME_LOCALS = new Set(['bits-combobox-anchor-width', 'ticker-duration', 'ticker-steps']);

const STATIC_KEYS = (() => {
	const src = readFileSync('src/lib/styles/tokens.ts', 'utf8');
	const block = src.split('export const STATIC_TOKENS')[1] ?? '';
	return [...block.matchAll(/'([a-z0-9-]+)':/g)].map((m) => m[1]);
})();

const DEFINED = new Set<string>([
	...TOKEN_KEYS,
	...STATIC_KEYS,
	...Array.from({ length: 12 }, (_, i) => `chart-band-${i + 1}`),
]);

describe('token discipline', () => {
	it('has no colour literals outside app.css and the LED group', () => {
		const offenders: string[] = [];
		for (const file of FILES) {
			if (LED_FILES.test(file)) continue;
			const text = readFileSync(file, 'utf8');
			for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([0-9]/g)) {
				const line = text.slice(0, m.index).split('\n').length;
				offenders.push(`${file}:${line} ${m[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('has no var() fallbacks on theme tokens', () => {
		// A fallback on a token that is always defined is dead code that drifts:
		// it only renders if the token is missing, and then it renders a stale
		// light-mode value. Component-scoped locals may still have them.
		const offenders: string[] = [];
		for (const file of FILES) {
			const text = readFileSync(file, 'utf8');
			for (const m of text.matchAll(/var\(\s*--([a-z0-9-]+)\s*,/g)) {
				if (!DEFINED.has(m[1])) continue;
				const line = text.slice(0, m.index).split('\n').length;
				offenders.push(`${file}:${line} --${m[1]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('references no token that is never defined', () => {
		// Locals are collected across ALL files, not per-file, because several are
		// deliberately cross-component: LedBoard declares --glyph-px and --led-pitch
		// on .board and DoorTicker reads them from inside it, and settings.css
		// declares --settings-nav-w for SettingsNav. That inheritance is the point.
		const locals = new Set<string>();
		for (const file of FILES) {
			const text = readFileSync(file, 'utf8');
			for (const m of text.matchAll(/^\s*--([a-z0-9-]+)\s*:/gm)) locals.add(m[1]);
		}
		const offenders: string[] = [];
		for (const file of FILES) {
			const text = readFileSync(file, 'utf8');
			for (const m of text.matchAll(/var\(\s*--([a-z0-9-]+)/g)) {
				const name = m[1];
				if (DEFINED.has(name) || locals.has(name) || RUNTIME_LOCALS.has(name)) continue;
				const line = text.slice(0, m.index).split('\n').length;
				offenders.push(`${file}:${line} --${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

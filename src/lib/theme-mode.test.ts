import { describe, it, expect } from 'vitest';
import {
	nextThemeMode,
	parseThemeMode,
	themeAttribute,
	themeToggleLabel,
	THEME_MODES,
	type ThemeMode,
} from './theme-mode.js';

describe('parseThemeMode', () => {
	it('accepts the explicit modes', () => {
		expect(parseThemeMode('light')).toBe('light');
		expect(parseThemeMode('dark')).toBe('dark');
	});

	// A stale or hand-edited cookie must not strand someone in a broken theme.
	it('falls back to following the device for anything else', () => {
		for (const raw of [undefined, null, '', 'system', 'System', 'DARK', 'nonsense', '{}']) {
			expect(parseThemeMode(raw)).toBe('system');
		}
	});
});

describe('nextThemeMode', () => {
	it('cycles system → light → dark → system', () => {
		expect(nextThemeMode('system')).toBe('light');
		expect(nextThemeMode('light')).toBe('dark');
		expect(nextThemeMode('dark')).toBe('system');
	});

	it('returns to the start after one full cycle', () => {
		let mode: ThemeMode = 'system';
		for (let i = 0; i < THEME_MODES.length; i++) mode = nextThemeMode(mode);
		expect(mode).toBe('system');
	});

	it('reaches every mode', () => {
		const seen = new Set<ThemeMode>();
		let mode: ThemeMode = 'system';
		for (let i = 0; i < THEME_MODES.length; i++) {
			seen.add(mode);
			mode = nextThemeMode(mode);
		}
		expect([...seen].sort()).toEqual([...THEME_MODES].sort());
	});
});

describe('themeAttribute', () => {
	// The emitted stylesheet keys its dark block off `:root:not([data-theme="light"])`,
	// so 'system' MUST produce no attribute or the media query stops governing.
	it('emits nothing for system', () => {
		expect(themeAttribute('system')).toBe('');
	});

	it('emits a leading space so it can be concatenated onto <html', () => {
		expect(themeAttribute('light')).toBe(' data-theme="light"');
		expect(themeAttribute('dark')).toBe(' data-theme="dark"');
	});

	it('produces valid markup when spliced into the tag', () => {
		for (const mode of THEME_MODES) {
			const html = `<html lang="en"${themeAttribute(mode)}>`;
			expect(html.startsWith('<html lang="en"')).toBe(true);
			expect(html.endsWith('>')).toBe(true);
			expect(html).not.toContain('""');
		}
	});
});

describe('themeToggleLabel', () => {
	it('says what a tap will do, for every mode', () => {
		for (const mode of THEME_MODES) {
			const label = themeToggleLabel(mode);
			expect(label).toMatch(/tap/i);
			expect(label.length).toBeGreaterThan(10);
		}
	});
});

import { describe, it, expect } from 'vitest';
import { DEFAULT_SITE_NAME, documentTitle, resolveSiteName } from './site-name.js';

describe('resolveSiteName', () => {
	it('uses the stored name when there is one', () => {
		expect(resolveSiteName('Abdul for US')).toBe('Abdul for US');
	});

	it('trims surrounding whitespace', () => {
		expect(resolveSiteName('  Abdul for US  ')).toBe('Abdul for US');
	});

	// '' is the "cleared" sentinel for app_config text fields, not a valid name.
	it('falls back to the default for unset, empty or whitespace-only', () => {
		for (const raw of [undefined, null, '', '   ', '\t\n']) {
			expect(resolveSiteName(raw)).toBe(DEFAULT_SITE_NAME);
		}
	});
});

describe('documentTitle', () => {
	it('composes page and site', () => {
		expect(documentTitle('Dashboard', 'Abdul for US')).toBe('Dashboard — Abdul for US');
		expect(documentTitle('Slack help list', 'Abdul for US')).toBe('Slack help list — Abdul for US');
	});

	// A dangling separator looks broken in a tab strip.
	it('drops the separator when the page has no title', () => {
		for (const raw of [undefined, null, '', '  ']) {
			expect(documentTitle(raw, 'Abdul for US')).toBe('Abdul for US');
		}
	});

	it('falls back to the default site name too', () => {
		expect(documentTitle('Settings', '')).toBe(`Settings — ${DEFAULT_SITE_NAME}`);
	});

	it('trims both halves', () => {
		expect(documentTitle('  Settings  ', '  Abdul for US ')).toBe('Settings — Abdul for US');
	});
});

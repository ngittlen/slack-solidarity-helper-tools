import { describe, it, expect } from 'vitest';
import {
	parseNavOpenPref,
	serializeNavOpenPref,
	initialNavOpen,
	shouldPersistNavOpen,
} from './nav-prefs.js';

describe('parseNavOpenPref', () => {
	it('reads the two values we write', () => {
		expect(parseNavOpenPref('1')).toBe(true);
		expect(parseNavOpenPref('0')).toBe(false);
	});

	it('treats a missing key as no preference', () => {
		expect(parseNavOpenPref(null)).toBeNull();
	});

	it('treats anything else as no preference rather than guessing', () => {
		// Covers hand-edited storage and any value an older build might have left
		// behind — falling back to the default beats coercing garbage to `true`.
		for (const raw of ['', 'true', 'false', 'yes', '2', '{}']) {
			expect(parseNavOpenPref(raw)).toBeNull();
		}
	});
});

describe('serializeNavOpenPref', () => {
	it('round-trips through parseNavOpenPref', () => {
		expect(parseNavOpenPref(serializeNavOpenPref(true))).toBe(true);
		expect(parseNavOpenPref(serializeNavOpenPref(false))).toBe(false);
	});
});

describe('initialNavOpen', () => {
	it('starts closed on mobile whatever is stored', () => {
		// The narrow layout drops the nav over the content; restoring it open
		// would cover the page on arrival.
		for (const stored of [true, false, null]) {
			expect(initialNavOpen({ isMobile: true, stored })).toBe(false);
		}
	});

	it('honours the stored preference on desktop', () => {
		expect(initialNavOpen({ isMobile: false, stored: true })).toBe(true);
		expect(initialNavOpen({ isMobile: false, stored: false })).toBe(false);
	});

	it('opens on a first desktop visit', () => {
		expect(initialNavOpen({ isMobile: false, stored: null })).toBe(true);
	});

	it('lets the caller override the desktop first-visit default', () => {
		expect(initialNavOpen({ isMobile: false, stored: null, defaultOpen: false })).toBe(false);
	});

	it('lets a stored `false` win over an open default', () => {
		expect(initialNavOpen({ isMobile: false, stored: false, defaultOpen: true })).toBe(false);
	});
});

describe('shouldPersistNavOpen', () => {
	it('persists desktop toggles', () => {
		expect(shouldPersistNavOpen(false)).toBe(true);
	});

	it('does not let a mobile toggle overwrite the desktop preference', () => {
		expect(shouldPersistNavOpen(true)).toBe(false);
	});
});

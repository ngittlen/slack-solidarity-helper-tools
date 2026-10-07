import { describe, it, expect } from 'vitest';
import { MAX_DISPLAY_NAME, tidyDisplayName } from './display-name.js';

describe('tidyDisplayName', () => {
	it('keeps an ordinary name as it is', () => {
		expect(tidyDisplayName('Ana Ruiz')).toBe('Ana Ruiz');
	});

	// The caller decides what no name means — on a sign-in, the name prompt.
	it('is empty when nothing usable is left', () => {
		expect(tidyDisplayName('')).toBe('');
		expect(tidyDisplayName('  \n\t ')).toBe('');
	});

	// The name is chosen by a stranger and ends up in Slack posts and sheets.
	it('makes it one tidy line', () => {
		expect(tidyDisplayName('Ana\nRuiz\r\n<!channel>\u0000  x')).toBe('Ana Ruiz <!channel> x');
	});

	it('caps the length', () => {
		const long = tidyDisplayName('a'.repeat(500));
		expect(long).toHaveLength(MAX_DISPLAY_NAME);
	});

	// Escaping `& < >` at the Slack sinks cannot stop either of these.
	it('defangs anything Slack would auto-link', () => {
		expect(tidyDisplayName('https://evil.example/login')).toBe('https evil·example/login');
		expect(tidyDisplayName('Log in at evil.com')).toBe('Log in at evil·com');
		expect(tidyDisplayName('J.R. Ortiz')).toBe('J.R. Ortiz');
	});

	it("drops Slack's formatting characters", () => {
		expect(tidyDisplayName('*Ana* _Ruiz_ ~x~ `y`')).toBe('Ana Ruiz x y');
	});

	it('defangs IP addresses and domains in any script', () => {
		expect(tidyDisplayName('10.0.0.1:8080/x')).toBe('10·0·0·1:8080/x');
		expect(tidyDisplayName('пример.рф')).toBe('пример·рф');
	});

	// Characters that draw nothing: a name made only of them is no name, and
	// one hidden inside a domain must not hide it from the link check.
	it('treats every invisible character as a space', () => {
		expect(tidyDisplayName('ㅤ')).toBe('');
		expect(tidyDisplayName('⠀ᅟ️')).toBe('');
		expect(tidyDisplayName('evil­.com')).not.toContain('evil.com');
		expect(tidyDisplayName('evil.c­om')).not.toContain('evil.com');
		expect(tidyDisplayName('Ana\u{e0041}\u{e0100}')).toBe('Ana');
	});

	it('removes bidi overrides and zero-width characters', () => {
		expect(tidyDisplayName('An​a‮ Ruiz⁦﻿')).toBe('An a Ruiz');
	});

	it('never cuts a character in half at the cap', () => {
		const emoji = '😀';
		const capped = tidyDisplayName(`${'a'.repeat(MAX_DISPLAY_NAME - 1)}${emoji}x`);
		expect(Array.from(capped)).toHaveLength(MAX_DISPLAY_NAME);
		expect(capped.endsWith(emoji)).toBe(true);
	});
});

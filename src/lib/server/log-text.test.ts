import { describe, it, expect } from 'vitest';
import { logText } from './log-text.js';

describe('logText', () => {
	it('quotes the value, so a newline cannot start a line of its own', () => {
		expect(logText('access_denied\n[auth] login: admin (U1) admin=true')).toBe(
			'"access_denied\\n[auth] login: admin (U1) admin=true"',
		);
	});

	it('caps a long value', () => {
		expect(logText('x'.repeat(1000))).toBe(`"${'x'.repeat(200)}…"`);
	});

	it('says null for a missing value', () => {
		expect(logText(null)).toBe('null');
	});
});

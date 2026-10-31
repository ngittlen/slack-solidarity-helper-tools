import { describe, it, expect } from 'vitest';
import { visitorAddress } from './visitor-address.js';

const request = (headers: Record<string, string> = {}) =>
	new Request('https://app.example/turfs', { headers });

describe('visitorAddress', () => {
	it('uses Fly-Client-IP on Fly', () => {
		expect(
			visitorAddress(request({ 'fly-client-ip': '203.0.113.9' }), () => '10.0.0.1', true),
		).toBe('203.0.113.9');
	});

	it('ignores Fly-Client-IP anywhere else, where the client controls it', () => {
		expect(
			visitorAddress(request({ 'fly-client-ip': '203.0.113.9' }), () => '10.0.0.1', false),
		).toBe('10.0.0.1');
	});

	it('falls back to the socket address on Fly when the header is missing', () => {
		expect(visitorAddress(request(), () => '10.0.0.1', true)).toBe('10.0.0.1');
	});

	it('shares one bucket when the address cannot be determined', () => {
		const unavailable = () => {
			throw new Error('no address');
		};
		expect(visitorAddress(request(), unavailable, false)).toBe('unknown');
	});
});

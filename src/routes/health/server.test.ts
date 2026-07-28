import { describe, it, expect } from 'vitest';
import { GET } from './+server.js';

describe('GET /health', () => {
	it('returns 200 with status ok', async () => {
		const res = await GET();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok' });
	});
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAttendance } from './rsvp.js';

// fetchWithRetry only intercepts 429, so stubbing global fetch is enough to
// drive every case here.
function stubFetch(status: number, body: string) {
	const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

const target = { eventId: 1, sessionId: 2, userId: 3 };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('createAttendance', () => {
	it('resolves on success', async () => {
		stubFetch(200, '{"data":{"id":1}}');
		await expect(createAttendance('token', target)).resolves.toBeUndefined();
	});

	// The regression this exists for: two overlapping syncs both write the same
	// attendance because the ledger record lands after the API call. The loser
	// got a 422 and was reported as a failure, paging on a row that already held
	// the state we wanted.
	it('treats a 422 "already been taken" as success, since the row exists', async () => {
		stubFetch(422, '{"errors":["User has already been taken"]}');
		await expect(createAttendance('token', target)).resolves.toBeUndefined();
	});

	it('still throws on a 422 that means something else', async () => {
		stubFetch(422, '{"errors":["Event session must exist"]}');
		await expect(createAttendance('token', target)).rejects.toThrow(
			/attendance create returned 422/,
		);
	});

	it('still throws on other failures', async () => {
		stubFetch(500, 'upstream exploded');
		await expect(createAttendance('token', target)).rejects.toThrow(
			/attendance create returned 500/,
		);
	});
});

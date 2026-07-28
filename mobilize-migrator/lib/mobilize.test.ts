import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEvent, MobilizeError, type MobilizeApiConfig } from './mobilize.js';

const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 44679 };

function stubResponse(status: number, body: unknown) {
	vi.stubGlobal('fetch', async () => ({
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
		headers: new Headers(),
	}));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('createEvent envelope', () => {
	// Verified against the live API: create nests the event one level deeper
	// than every other endpoint. Reading data.id returns undefined and every
	// create fails — which is exactly what happened the first time this ran.
	it('reads the id out of the nested data.event the API actually returns', async () => {
		stubResponse(200, {
			data: {
				event: {
					id: 997953,
					title: 'Detroit Canvass',
					timeslots: [{ id: 6196910, start_date: 1816715959, end_date: 1816723159 }],
				},
			},
			error: null,
		});

		const result = await createEvent(API, {});

		expect(result.id).toBe(997953);
		// The created event comes back with its new timeslot ids, so the caller
		// can pair them without a read-back.
		expect(result.event?.timeslots[0].id).toBe(6196910);
	});

	it('still accepts a flat data.event shape', async () => {
		stubResponse(200, { data: { id: 12345, title: 'X', timeslots: [] }, error: null });
		expect((await createEvent(API, {})).id).toBe(12345);
	});

	it('throws rather than recording a bogus ledger row when no id comes back', async () => {
		stubResponse(200, { data: { event: { title: 'no id here' } }, error: null });
		await expect(createEvent(API, {})).rejects.toThrow(/no event id/);
	});

	it('surfaces a 403 as a MobilizeError so the sync can report authFailed', async () => {
		stubResponse(403, { data: null, error: { detail: 'nope' } });
		await expect(createEvent(API, {})).rejects.toBeInstanceOf(MobilizeError);
		stubResponse(403, { data: null, error: { detail: 'nope' } });
		await expect(createEvent(API, {})).rejects.toThrow(/lacks the write access/);
	});

	it('treats an error in a 200 body as a failure', async () => {
		// The API answers 200 with {"data":null,"error":{…}} for validation
		// failures like a timeslot more than five years out.
		stubResponse(200, {
			data: null,
			error: {
				timeslots: [
					{ non_field_errors: ['Cannot create timeslots more than 5 years in the future'] },
				],
			},
		});
		await expect(createEvent(API, {})).rejects.toThrow(/5 years/);
	});
});

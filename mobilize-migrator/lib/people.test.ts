import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	buildZipChapterMap,
	createUser,
	findExistingUser,
	normalizeEmail,
	normalizePhone,
	resolveChapterId,
} from './people.js';
import { attendingFor } from './rsvp.js';

const TOKEN = 'test-token';

function mockFetch(handler: (url: string) => { ok?: boolean; body: unknown }) {
	const spy = vi.fn(async (url: string | URL) => {
		const { ok = true, body } = handler(String(url));
		return {
			ok,
			status: ok ? 200 : 500,
			json: async () => body,
			text: async () => JSON.stringify(body),
			headers: new Headers(),
		} as unknown as Response;
	});
	vi.stubGlobal('fetch', spy);
	return spy;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('normalizePhone', () => {
	it('promotes a bare 10-digit US number to the stored form', () => {
		// Mobilize hands us "6169539282"; Solidarity stores "16169539282".
		expect(normalizePhone('6169539282')).toBe('16169539282');
	});

	it('accepts an already-prefixed number and strips punctuation', () => {
		expect(normalizePhone('+1 (616) 953-9282')).toBe('16169539282');
		expect(normalizePhone('16169539282')).toBe('16169539282');
	});

	it('refuses anything not safely matchable', () => {
		expect(normalizePhone('12345')).toBeNull();
		expect(normalizePhone('')).toBeNull();
		expect(normalizePhone(null)).toBeNull();
	});
});

describe('normalizeEmail', () => {
	it('lowercases and trims', () => {
		expect(normalizeEmail('  Kathryn@Example.COM ')).toBe('kathryn@example.com');
	});

	it('rejects non-addresses', () => {
		expect(normalizeEmail('not-an-email')).toBeNull();
		expect(normalizeEmail(null)).toBeNull();
	});
});

describe('findExistingUser', () => {
	const person = {
		firstName: 'A',
		lastName: 'B',
		email: 'a@example.com',
		phone: '6169539282',
		zipcode: '49504',
	};

	it('uses phone_number, never phone, when falling back to phone lookup', async () => {
		// Regression guard. Solidarity ACCEPTS ?phone= and silently ignores it,
		// returning an unfiltered user list — matching on that would attach
		// signups to arbitrary strangers.
		const spy = mockFetch((url) =>
			url.includes('email=') ? { body: { data: [] } } : { body: { data: [{ id: 42 }] } },
		);

		const result = await findExistingUser(TOKEN, person);

		expect(result).toEqual({ user: { id: 42 }, method: 'phone' });
		const phoneCall = spy.mock.calls.map((c) => String(c[0])).find((u) => u.includes('phone'));
		expect(phoneCall).toContain('phone_number=');
		expect(phoneCall).not.toMatch(/[?&]phone=/);
	});

	it('prefers an email match and does not fall through to phone', async () => {
		const spy = mockFetch(() => ({ body: { data: [{ id: 7 }] } }));

		const result = await findExistingUser(TOKEN, person);

		expect(result).toEqual({ user: { id: 7 }, method: 'email' });
		expect(spy.mock.calls).toHaveLength(1);
		expect(String(spy.mock.calls[0]![0])).toContain('email=');
	});

	it('sends the normalized phone, not what Mobilize gave us', async () => {
		const spy = mockFetch((url) =>
			url.includes('email=') ? { body: { data: [] } } : { body: { data: [] } },
		);

		await findExistingUser(TOKEN, person);

		const phoneCall = spy.mock.calls
			.map((c) => String(c[0]))
			.find((u) => u.includes('phone_number'));
		expect(phoneCall).toContain('phone_number=16169539282');
	});

	it('refuses to match when an identifier hits more than one person', async () => {
		// Ambiguity must not resolve to "the first one" — that files someone
		// else's RSVP against a real member.
		mockFetch(() => ({ body: { data: [{ id: 1 }, { id: 2 }] } }));

		expect(await findExistingUser(TOKEN, person)).toBeNull();
	});

	it('skips lookups entirely when there is nothing to match on', async () => {
		const spy = mockFetch(() => ({ body: { data: [] } }));

		const result = await findExistingUser(TOKEN, {
			firstName: 'A',
			lastName: 'B',
			email: null,
			phone: null,
			zipcode: null,
		});

		expect(result).toBeNull();
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('createUser', () => {
	const person = {
		firstName: 'A',
		lastName: 'B',
		email: 'a@example.com',
		phone: '6165551234',
		zipcode: '49504',
	};

	// Regression: `/v1/users` returns a single user BARE while the rest of the API
	// wraps in `data`. Reading only `data.id` threw "returned no id" on profiles
	// Solidarity had really created — the person existed, their RSVP did not.
	it('reads the id from a bare response', async () => {
		mockFetch(() => ({ body: { id: 15404367, email: 'a@example.com' } }));

		expect(await createUser(TOKEN, person, 1330)).toEqual({ id: 15404367 });
	});

	it('still reads the id from a data-wrapped response', async () => {
		mockFetch(() => ({ body: { data: { id: 15404367 } } }));

		expect(await createUser(TOKEN, person, 1330)).toEqual({ id: 15404367 });
	});

	it('names the shape it got without echoing contact details into Slack', async () => {
		mockFetch(() => ({ body: { user: { id: 1, email: 'a@example.com' } } }));

		await expect(createUser(TOKEN, person, 1330)).rejects.toThrow(/response keys: user/);
		await expect(createUser(TOKEN, person, 1330)).rejects.not.toThrow(/example\.com/);
	});
});

describe('buildZipChapterMap', () => {
	it('picks the chapter most existing members in that zip belong to', () => {
		const map = buildZipChapterMap([
			{ address: { zip_code: '48104' }, chapter_ids: [1305] },
			{ address: { zip_code: '48104' }, chapter_ids: [1305] },
			{ address: { zip_code: '48104' }, chapter_ids: [1322] },
			{ address: { zip_code: '49504' }, chapter_ids: [1315] },
		]);
		expect(map.get('48104')).toEqual({ chapterId: 1305, memberCount: 2 });
		expect(map.get('49504')).toEqual({ chapterId: 1315, memberCount: 1 });
	});

	it('ignores members with no zip', () => {
		const map = buildZipChapterMap([
			{ address: null, chapter_ids: [1305] },
			{ address: { zip_code: null }, chapter_ids: [1305] },
		]);
		expect(map.size).toBe(0);
	});

	it('counts a member in every chapter they belong to', () => {
		const map = buildZipChapterMap([{ address: { zip_code: '48104' }, chapter_ids: [1, 2] }]);
		// Tie broken deterministically by lower chapter id.
		expect(map.get('48104')?.chapterId).toBe(1);
	});
});

describe('resolveChapterId', () => {
	const resolver = {
		byZip: (zip: string | null) => (zip === '48104' ? 1305 : null),
		eventChapterId: 1330,
		defaultChapterId: 999,
	};

	it('prefers the zip match', () => {
		expect(resolveChapterId(resolver, '48104')).toBe(1305);
	});

	it('falls back to the chapter that owns the event', () => {
		expect(resolveChapterId(resolver, '99999')).toBe(1330);
		expect(resolveChapterId(resolver, null)).toBe(1330);
	});

	it('falls back to the default when the event has no chapter', () => {
		expect(resolveChapterId({ ...resolver, eventChapterId: null }, null)).toBe(999);
	});

	it('returns null rather than inventing a chapter', () => {
		expect(
			resolveChapterId({ ...resolver, eventChapterId: null, defaultChapterId: null }, null),
		).toBeNull();
	});
});

describe('attendingFor', () => {
	it('maps registered and confirmed to yes, cancelled to no', () => {
		expect(attendingFor('REGISTERED')).toBe('yes');
		// CONFIRMED is a reconfirmed registration — the same intent, firmer.
		expect(attendingFor('CONFIRMED')).toBe('yes');
		expect(attendingFor('CANCELLED')).toBe('no');
	});

	it('refuses to guess an unrecognized status', () => {
		expect(attendingFor('UNKNOWN')).toBeNull();
	});
});

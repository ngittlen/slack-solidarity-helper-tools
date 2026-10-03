import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { VanError } from '$lib/server/van/client.js';

// "Test connection": the campaign's own key, two reads, and nothing from the
// secret in what comes back.

const { holder, mockClientFor, mockFolders, mockJobTypes } = vi.hoisted(() => ({
	holder: { db: null as unknown },
	mockClientFor: vi.fn(),
	mockFolders: vi.fn(),
	mockJobTypes: vi.fn(),
}));

vi.mock('$lib/server/db.js', () => ({
	get db() {
		return holder.db;
	},
}));
vi.mock('$lib/server/van-env.js', () => ({ vanClientFor: mockClientFor }));

import { POST } from './+server.js';

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true };
const API_KEY = 'secret-key-0000|1';

function test(opts: { id?: string; session?: unknown } = {}) {
	return POST({
		locals: { session: opts.session === undefined ? ADMIN : opts.session },
		params: { id: opts.id ?? '1' },
	} as never);
}

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	holder.db = drizzle(client);
	await migrate(holder.db as ReturnType<typeof drizzle>, { migrationsFolder: 'drizzle' });
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	mockFolders.mockResolvedValue([
		{ folderId: 2, name: 'Wayne' },
		{ folderId: 1, name: 'Allegan' },
	]);
	mockJobTypes.mockResolvedValue([{ exportJobTypeId: 5, name: 'VoterCircle' }]);
	// The client holds the key, as the real one does; the route must not
	// carry any of it into the response.
	mockClientFor.mockReturnValue({
		ok: true,
		client: { apiKey: API_KEY, folders: mockFolders, exportJobTypes: mockJobTypes },
	});
});

describe('auth', () => {
	it('401s without a session', async () => {
		expect((await test({ session: null })).status).toBe(401);
		expect(mockFolders).not.toHaveBeenCalled();
	});

	it('403s for a signed-in non-admin', async () => {
		expect((await test({ session: { ...ADMIN, isAdmin: false } })).status).toBe(403);
		expect(mockFolders).not.toHaveBeenCalled();
	});

	it('404s for a campaign that does not exist', async () => {
		expect((await test({ id: '99' })).status).toBe(404);
	});
});

describe('the test', () => {
	it('lists the folders by name, and the export job types', async () => {
		const body = await (await test()).json();
		expect(body).toEqual({
			ok: true,
			folders: [
				{ folderId: 1, name: 'Allegan' },
				{ folderId: 2, name: 'Wayne' },
			],
			exportJobTypes: [{ exportJobTypeId: 5, name: 'VoterCircle' }],
			errors: [],
		});
		expect(JSON.stringify(body)).not.toContain(API_KEY);
	});

	it('says what a rejected key means, rather than the bare status', async () => {
		mockFolders.mockRejectedValue(new VanError('/folders', 401, [], ''));
		mockJobTypes.mockRejectedValue(new VanError('/exportJobTypes', 403, [], ''));
		const body = await (await test()).json();
		expect(body.ok).toBe(false);
		expect(body.errors).toEqual([
			expect.stringContaining('credentials rejected'),
			expect.stringContaining('not granted to this key'),
		]);
	});

	// Folders are what proves the key; a tier without export types still works.
	it('passes when only the export job types are refused', async () => {
		mockJobTypes.mockRejectedValue(new VanError('/exportJobTypes', 403, [], ''));
		const body = await (await test()).json();
		expect(body.ok).toBe(true);
		expect(body.exportJobTypes).toBeNull();
		expect(body.errors).toHaveLength(1);
	});

	it('says why when the campaign has no credentials, without calling VAN', async () => {
		mockClientFor.mockReturnValue({ ok: false, error: 'VAN_CAMPAIGN_PRIMARY is not set' });
		const body = await (await test()).json();
		expect(body).toMatchObject({ ok: false, errors: ['VAN_CAMPAIGN_PRIMARY is not set'] });
		expect(mockFolders).not.toHaveBeenCalled();
	});
});

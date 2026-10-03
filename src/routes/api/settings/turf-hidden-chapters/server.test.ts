import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// Chapters hidden from /turfs, on a real in-memory database: the check that a
// chapter is one /turfs lists reads the chapter → channel map.

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));

vi.mock('$lib/server/db.js', () => ({
	get db() {
		return holder.db;
	},
}));

import { POST } from './+server.js';
import { loadSettings } from '$lib/server/settings.js';

let client: ReturnType<typeof createClient>;

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Alice', isAdmin: true };

function post(body: unknown, session: unknown = ADMIN) {
	return POST({
		locals: { session },
		request: { json: async () => body },
	} as never);
}

const hidden = async () =>
	[...(await loadSettings(holder.db as ReturnType<typeof drizzle>)).turfHiddenChapterIds].sort();

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	holder.db = drizzle(client);
	await migrate(holder.db as ReturnType<typeof drizzle>, { migrationsFolder: 'drizzle' });
	await client.execute(
		`INSERT INTO chapter_channel_map (chapter_id, channel_id, name, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (71, 'C1', 'Washtenaw County', 'U', 'u', 'x'), (1, 'C2', 'Michigan', 'U', 'u', 'x')`,
	);
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('auth', () => {
	it('401s without a session, 403s for a non-admin', async () => {
		expect((await post({ action: 'add', chapterId: 1 }, null)).status).toBe(401);
		expect((await post({ action: 'add', chapterId: 1 }, { ...ADMIN, isAdmin: false })).status).toBe(
			403,
		);
		expect(await hidden()).toEqual([]);
	});
});

describe('hiding and showing', () => {
	it('hides a chapter, and shows it again', async () => {
		expect((await post({ action: 'add', chapterId: 1 })).status).toBe(200);
		expect(await hidden()).toEqual([1]);
		expect((await post({ action: 'remove', chapterId: 1 })).status).toBe(200);
		expect(await hidden()).toEqual([]);
	});

	it('takes the same chapter twice as one', async () => {
		await post({ action: 'add', chapterId: 1 });
		expect((await post({ action: 'add', chapterId: 1 })).status).toBe(200);
		expect(await hidden()).toEqual([1]);
	});

	// /turfs only lists chapters with a Slack channel mapped.
	it('refuses to hide a chapter /turfs does not list', async () => {
		const res = await post({ action: 'add', chapterId: 999 });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain('no Slack channel mapped');
	});

	// So a chapter hidden and later dropped from the map can still be shown.
	it('shows a chapter whatever the map says', async () => {
		await post({ action: 'add', chapterId: 1 });
		await client.execute('DELETE FROM chapter_channel_map WHERE chapter_id = 1');
		expect((await post({ action: 'remove', chapterId: 1 })).status).toBe(200);
		expect(await hidden()).toEqual([]);
	});

	it('refuses a malformed request', async () => {
		expect((await post({ action: 'hide', chapterId: 1 })).status).toBe(400);
		expect((await post({ action: 'add', chapterId: '1' })).status).toBe(400);
	});
});

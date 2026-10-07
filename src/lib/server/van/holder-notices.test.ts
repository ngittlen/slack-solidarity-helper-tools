import { readFileSync } from 'node:fs';
import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

const mockSendDm = vi.hoisted(() => vi.fn());
vi.mock('../slack-dm.js', () => ({ sendDm: mockSendDm }));

import {
	dismissHolderNotice,
	loadHolderNotices,
	notifyHolder,
	NOTICE_MAX_AGE_MS,
	pruneHolderNotices,
} from './holder-notices.js';

// A real in-memory libsql built from the real migration.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
	vi.clearAllMocks();
	mockSendDm.mockResolvedValue(true);
	client = createClient({ url: ':memory:' });
	for (const statement of readFileSync('drizzle/0062_turf_notices.sql', 'utf8').split(
		'--> statement-breakpoint',
	)) {
		await client.execute(statement);
	}
	db = drizzle(client);
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

const NOW = new Date('2026-10-04T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('notifyHolder', () => {
	it('DMs a Slack holder, storing nothing', async () => {
		expect(await notifyHolder(db, 'U123', 'expiry', 'hello', '[test]', NOW)).toBe(true);
		expect(mockSendDm).toHaveBeenCalledWith('U123', 'hello', '[test]');
		expect(await loadHolderNotices(db, 'U123', NOW)).toEqual([]);
	});

	it('passes a failed DM back, so the sweep retries', async () => {
		mockSendDm.mockResolvedValue(false);
		expect(await notifyHolder(db, 'U123', 'expiry', 'hello', '[test]', NOW)).toBe(false);
	});

	it('keeps the message for a Google holder instead of calling Slack', async () => {
		expect(await notifyHolder(db, 'google:7', 'unsynced', '*Sync?*', '[test]', NOW)).toBe(true);
		expect(mockSendDm).not.toHaveBeenCalled();
		expect(await loadHolderNotices(db, 'google:7', NOW)).toEqual([
			{ id: expect.any(Number), kind: 'unsynced', text: '*Sync?*', createdAt: NOW.toISOString() },
		]);
	});

	it('keeps the message for an Apple holder too', async () => {
		expect(await notifyHolder(db, 'apple:001.abc', 'expiry', 'Expiring', '[test]', NOW)).toBe(true);
		expect(mockSendDm).not.toHaveBeenCalled();
		expect(await loadHolderNotices(db, 'apple:001.abc', NOW)).toHaveLength(1);
	});

	it('reports a failed write as undelivered, so the sweep retries', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		client.close();
		expect(await notifyHolder(db, 'google:7', 'expiry', 'x', '[test]', NOW)).toBe(false);
	});
});

describe('loadHolderNotices', () => {
	it("returns only the holder's own, newest first", async () => {
		await notifyHolder(db, 'google:7', 'expiry', 'older', '[t]', hoursAgo(2));
		await notifyHolder(db, 'google:7', 'recut', 'newer', '[t]', hoursAgo(1));
		await notifyHolder(db, 'google:8', 'expiry', 'not yours', '[t]', hoursAgo(1));
		expect((await loadHolderNotices(db, 'google:7', NOW)).map((n) => n.text)).toEqual([
			'newer',
			'older',
		]);
	});

	// A read never writes; the prune below does the deleting.
	it('leaves out notices past their age, without deleting them', async () => {
		const tooOld = new Date(NOW.getTime() - NOTICE_MAX_AGE_MS - 1000);
		await notifyHolder(db, 'google:7', 'expiry', 'stale', '[t]', tooOld);
		await notifyHolder(db, 'google:7', 'expiry', 'fresh', '[t]', hoursAgo(1));
		expect((await loadHolderNotices(db, 'google:7', NOW)).map((n) => n.text)).toEqual(['fresh']);
		const remaining = await client.execute('SELECT count(*) AS n FROM turf_notices');
		expect(Number(remaining.rows[0]!.n)).toBe(2);
	});
});

describe('pruneHolderNotices', () => {
	// The week-at-most promise has to hold for a volunteer who never comes
	// back, so this is not scoped to anyone.
	it("deletes every holder's old notices, read or not, and keeps the rest", async () => {
		const tooOld = new Date(NOW.getTime() - NOTICE_MAX_AGE_MS - 1000);
		await notifyHolder(db, 'google:7', 'expiry', 'stale 7', '[t]', tooOld);
		await notifyHolder(db, 'google:8', 'recut', 'stale 8', '[t]', tooOld);
		await notifyHolder(db, 'google:8', 'expiry', 'fresh 8', '[t]', hoursAgo(1));

		expect(await pruneHolderNotices(db, NOW)).toBe(2);
		const left = await client.execute('SELECT text FROM turf_notices');
		expect(left.rows.map((r) => r.text)).toEqual(['fresh 8']);
		expect(await pruneHolderNotices(db, NOW)).toBe(0);
	});
});

describe('dismissHolderNotice', () => {
	it("removes the holder's notice, and nobody else's", async () => {
		await notifyHolder(db, 'google:7', 'expiry', 'mine', '[t]', hoursAgo(1));
		await notifyHolder(db, 'google:8', 'expiry', 'theirs', '[t]', hoursAgo(1));
		const [mine] = await loadHolderNotices(db, 'google:7', NOW);
		const [theirs] = await loadHolderNotices(db, 'google:8', NOW);

		// Someone guessing another holder's id dismisses nothing.
		await dismissHolderNotice(db, 'google:7', theirs!.id);
		expect(await loadHolderNotices(db, 'google:8', NOW)).toHaveLength(1);

		await dismissHolderNotice(db, 'google:7', mine!.id);
		expect(await loadHolderNotices(db, 'google:7', NOW)).toEqual([]);
	});
});

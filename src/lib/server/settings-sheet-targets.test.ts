import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { deleteVanSheetTarget, loadVanSheetTargets, saveVanSheetTarget } from './settings.js';

// The Packet Tracker's routing rules are each campaign's own
// (specs/012-multi-van-campaigns): the same prefix may route to different
// spreadsheets in different campaigns. On a real in-memory database, because
// the composite key is the behaviour under test.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const EDITOR = { id: 'U_ADMIN', name: 'Alice' };

const save = (campaignId: number, prefix: string, spreadsheetId: string, label = prefix) =>
	saveVanSheetTarget(db, { campaignId, prefix, label, spreadsheetId }, EDITOR);

const sheetsOf = async (campaignId: number) =>
	(await loadVanSheetTargets(db, campaignId)).map((t) => [t.prefixKey, t.spreadsheetId]);

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await client.execute(
		`INSERT INTO van_campaigns (id, credential_key, last_edited_by, last_edited_by_name, last_edited_at)
		 VALUES (2, 'partner', 'sync', 'sync', 'x')`,
	);
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('sheet rules per campaign', () => {
	it('keeps the same prefix as two rules in two campaigns', async () => {
		await save(1, 'R10C', 'sheet-primary');
		await save(2, 'R10C', 'sheet-partner');

		expect(await sheetsOf(1)).toEqual([['r10c', 'sheet-primary']]);
		expect(await sheetsOf(2)).toEqual([['r10c', 'sheet-partner']]);
	});

	it('edits the rule in place when its campaign saves the prefix again', async () => {
		await save(1, 'R10C', 'sheet-old');
		await save(1, 'r10c', 'sheet-new');
		expect(await sheetsOf(1)).toEqual([['r10c', 'sheet-new']]);
	});

	it('deletes only the campaign’s own rule', async () => {
		await save(1, 'R10C', 'sheet-primary');
		await save(2, 'R10C', 'sheet-partner');

		await deleteVanSheetTarget(db, 2, 'r10c', EDITOR);

		expect(await sheetsOf(1)).toEqual([['r10c', 'sheet-primary']]);
		expect(await sheetsOf(2)).toEqual([]);
	});

	// A spreadsheet is one document whoever routes to it, so it has one name.
	it('names a spreadsheet the same in every rule that points at it, across campaigns', async () => {
		await save(1, 'R10C', 'sheet-shared', 'sheet-shared');
		await save(2, 'R10D', 'sheet-shared', 'Downriver tracker');

		const labels = [
			...(await loadVanSheetTargets(db, 1)),
			...(await loadVanSheetTargets(db, 2)),
		].map((t) => t.label);
		expect(labels).toEqual(['Downriver tracker', 'Downriver tracker']);
	});
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { campaignRefreshSwitches, regionRefreshAllowed } from './campaigns.js';

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

async function campaign(id: number, label: string, enabled: boolean, refresh: boolean) {
	await client.execute({
		sql: `INSERT INTO van_campaigns
		        (id, credential_key, label, enabled, refresh_enabled,
		         last_edited_by, last_edited_by_name, last_edited_at)
		      VALUES (?, ?, ?, ?, ?, 's', 's', 'x')`,
		args: [id, `c${id}`, label, enabled ? 1 : 0, refresh ? 1 : 0],
	});
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await client.execute(
		`UPDATE van_campaigns SET label = 'One Team Michigan', refresh_enabled = 1 WHERE id = 1`,
	);
});

describe('regionRefreshAllowed', () => {
	// A re-cut deletes a campaign's printed lists, so anything short of a real
	// true — a hand edit, a missing value — is off.
	it('is the campaign’s own switch, strictly', () => {
		expect(regionRefreshAllowed({ refreshEnabled: true })).toBe(true);
		expect(regionRefreshAllowed({ refreshEnabled: false })).toBe(false);
		expect(regionRefreshAllowed({ refreshEnabled: 1 as never })).toBe(false);
	});
});

describe('campaignRefreshSwitches', () => {
	it('names the enabled campaigns by whether the sync re-cuts their regions', async () => {
		await campaign(2, 'Partner', true, false);
		await campaign(3, 'Paused', false, true);

		expect(await campaignRefreshSwitches(db)).toEqual({
			on: ['One Team Michigan'],
			off: ['Partner'],
		});
	});
});

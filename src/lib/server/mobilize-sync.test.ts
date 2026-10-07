import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// Only the echo guard is under test here: which Solidarity events reach the
// planner. Everything around it is stubbed; the ledger read is real SQL.

vi.mock('./env.js', () => ({ MOBILIZE_SYNC_MAX_CREATES: 25, SOLIDARITY_API_TOKEN: 't' }));
vi.mock('./mobilize-api.js', () => ({ loadMobilizeApi: () => ({ apiKey: 'k', orgId: 7 }) }));
vi.mock('./settings.js', () => ({
	loadSettings: async () => ({
		mobilizeContactName: 'Field',
		mobilizeContactEmail: 'field@example.org',
		mobilizeContactPhone: '',
	}),
}));
const fetchAllEvents = vi.hoisted(() => vi.fn());
vi.mock('../../../mobilize-migrator/lib/solidarity.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../mobilize-migrator/lib/solidarity.js')>()),
	fetchAllEvents,
}));
vi.mock('../../../mobilize-migrator/lib/pages.js', () => ({
	fetchPageDescriptions: async () => new Map(),
}));
const planMigration = vi.hoisted(() =>
	vi.fn<(events: { id: number }[]) => object>(() => ({
		planned: [],
		skipped: [],
		excludedByTag: [],
		duplicateSessions: [],
	})),
);
vi.mock('../../../mobilize-migrator/lib/transform.js', () => ({ planMigration }));
vi.mock('../../../mobilize-migrator/lib/sync.js', () => ({
	runSync: async () => ({ planned: 0, created: 0, updated: 0, failed: 0, errors: [] }),
}));

const { runMobilizeSync } = await import('./mobilize-sync.js');

let client: ReturnType<typeof createClient>;
let db: ReturnType<typeof drizzle>;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	vi.spyOn(console, 'log').mockImplementation(() => {});
	planMigration.mockClear();
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

describe('runMobilizeSync — the echo guard', () => {
	it('never plans an event the partner-org import created, tag or no tag', async () => {
		await client.execute(
			`INSERT INTO mobilize_imported_events
			   (mobilize_event_id, source_org_id, solidarity_event_id, status, title, created_at, updated_at)
			 VALUES (1, 42, 900, 'complete', 'Imported', 'x', 'x'),
			        (2, 42, NULL, 'duplicate', 'Refused', 'x', 'x')`,
		);
		// Event 900 carries no mobilize-exclude tag: as if Solidarity had
		// dropped it on create, which is the case this guard exists for.
		fetchAllEvents.mockResolvedValue([
			{ id: 900, title: 'Imported', tags: [] },
			{ id: 901, title: 'Ours', tags: [] },
		]);
		await runMobilizeSync(db, { apply: false });
		const planned = planMigration.mock.calls[0][0];
		expect(planned.map((e) => e.id)).toEqual([901]);
	});

	it('passes everything through when nothing was imported', async () => {
		fetchAllEvents.mockResolvedValue([{ id: 901, title: 'Ours', tags: [] }]);
		await runMobilizeSync(db, { apply: false });
		expect(planMigration.mock.calls[0][0].map((e) => e.id)).toEqual([901]);
	});
});

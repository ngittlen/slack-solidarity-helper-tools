import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

import { TursoImportLedger } from './mobilize-import-ledger.js';
import { importedSolidarityEventIds } from './mobilize-sync.js';

// A real in-memory libsql with the real migrations, so the queries — the
// failure-count upsert above all — run as SQL rather than as mocks.
let client: ReturnType<typeof createClient>;
let db: ReturnType<typeof drizzle>;
let ledger: TursoImportLedger;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	ledger = new TursoImportLedger(db, 42);
});

afterEach(() => client.close());

describe('TursoImportLedger', () => {
	it('records an event and its timeslots, and reads them back together', async () => {
		await ledger.recordEvent({
			mobilizeEventId: 1,
			solidarityEventId: 900,
			status: 'created',
			title: 'Canvass',
		});
		await ledger.recordTimeslot({
			mobilizeTimeslotId: 10,
			mobilizeEventId: 1,
			solidaritySessionId: null,
		});
		await ledger.recordTimeslot({
			mobilizeTimeslotId: 11,
			mobilizeEventId: 1,
			solidaritySessionId: 5,
		});

		const [record] = await ledger.all();
		expect(record).toMatchObject({
			mobilizeEventId: 1,
			solidarityEventId: 900,
			status: 'created',
			title: 'Canvass',
			failedAttempts: 0,
			stalledReportedAt: null,
		});
		expect([...record.importedTimeslotIds].sort()).toEqual([10, 11]);
	});

	it('marks an import complete with its page', async () => {
		await ledger.recordEvent({
			mobilizeEventId: 1,
			solidarityEventId: 900,
			status: 'created',
			title: 'Canvass',
		});
		await ledger.markComplete(1, 'https://p/900');
		const rows = await client.execute(
			'SELECT status, solidarity_page_url, source_org_id FROM mobilize_imported_events',
		);
		expect(rows.rows[0]).toMatchObject({
			status: 'complete',
			solidarity_page_url: 'https://p/900',
			source_org_id: 42,
		});
	});

	it('counts failures in one upsert: a new row starts failing at 1, then climbs', async () => {
		expect(await ledger.recordFailure({ mobilizeEventId: 1, title: 'Canvass' })).toBe(1);
		expect(await ledger.recordFailure({ mobilizeEventId: 1, title: 'Canvass' })).toBe(2);
		const [record] = await ledger.all();
		expect(record).toMatchObject({ status: 'failing', solidarityEventId: null, failedAttempts: 2 });
	});

	it('keeps an existing row’s status when counting a failure, and resets the count on a new state', async () => {
		await ledger.recordEvent({
			mobilizeEventId: 1,
			solidarityEventId: 900,
			status: 'created',
			title: 'Canvass',
		});
		expect(await ledger.recordFailure({ mobilizeEventId: 1, title: 'Canvass' })).toBe(1);
		expect((await ledger.all())[0].status).toBe('created');

		await ledger.recordEvent({
			mobilizeEventId: 1,
			solidarityEventId: 900,
			status: 'created',
			title: 'Canvass',
		});
		expect((await ledger.all())[0].failedAttempts).toBe(0);
	});

	it('sets a status, and stamps stalled reports only for the ids given', async () => {
		for (const id of [1, 2]) {
			await ledger.recordEvent({
				mobilizeEventId: id,
				solidarityEventId: 900 + id,
				status: 'created',
				title: `E${id}`,
			});
		}
		await ledger.setStatus(2, 'rejected');
		await ledger.markStalledReported([1]);
		await ledger.markStalledReported([]);
		const byId = new Map((await ledger.all()).map((r) => [r.mobilizeEventId, r]));
		expect(byId.get(1)!.stalledReportedAt).not.toBeNull();
		expect(byId.get(2)).toMatchObject({ status: 'rejected', stalledReportedAt: null });
	});
});

describe('importedSolidarityEventIds (the outbound sync’s echo guard)', () => {
	it('returns every Solidarity event the import created, and nothing for refusals', async () => {
		await ledger.recordEvent({
			mobilizeEventId: 1,
			solidarityEventId: 900,
			status: 'complete',
			title: 'A',
		});
		await ledger.recordEvent({
			mobilizeEventId: 2,
			solidarityEventId: 901,
			status: 'created',
			title: 'B',
		});
		await ledger.recordEvent({
			mobilizeEventId: 3,
			solidarityEventId: null,
			status: 'duplicate',
			title: 'C',
		});
		expect(await importedSolidarityEventIds(db)).toEqual(new Set([900, 901]));
	});
});

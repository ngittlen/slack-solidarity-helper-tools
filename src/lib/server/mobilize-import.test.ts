import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

import type { MobilizeEvent } from '../../../mobilize-migrator/lib/mobilize.js';

// Getters, so each test can change the "environment" after the module under
// test has imported it.
const env = vi.hoisted(() => ({
	MOBILIZE_IMPORT_API_KEY: 'partner-key',
	MOBILIZE_IMPORT_ORG_ID: 42,
	MOBILIZE_IMPORT_MAX_CREATES: 10,
	SOLIDARITY_DEFAULT_CHAPTER_ID: 1,
	SOLIDARITY_API_TOKEN: 'sol-token',
}));
vi.mock('./env.js', () => ({
	get MOBILIZE_API_KEY() {
		return 'ours';
	},
	get MOBILIZE_ORG_ID() {
		return 7;
	},
	get MOBILIZE_IMPORT_API_KEY() {
		return env.MOBILIZE_IMPORT_API_KEY;
	},
	get MOBILIZE_IMPORT_ORG_ID() {
		return env.MOBILIZE_IMPORT_ORG_ID;
	},
	get MOBILIZE_IMPORT_MAX_CREATES() {
		return env.MOBILIZE_IMPORT_MAX_CREATES;
	},
	get SOLIDARITY_DEFAULT_CHAPTER_ID() {
		return env.SOLIDARITY_DEFAULT_CHAPTER_ID;
	},
	get SOLIDARITY_API_TOKEN() {
		return env.SOLIDARITY_API_TOKEN;
	},
}));

const settings = vi.hoisted(() => ({ mobilizeImportTag: 'shared shift' }));
vi.mock('./settings.js', () => ({ loadSettings: async () => settings }));

const listUpcomingOrgEvents = vi.hoisted(() => vi.fn());
vi.mock('../../../mobilize-migrator/lib/mobilize.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../mobilize-migrator/lib/mobilize.js')>()),
	listUpcomingOrgEvents,
}));

const { runMobilizeImport } = await import('./mobilize-import.js');
const { MobilizeError } = await import('../../../mobilize-migrator/lib/mobilize.js');

let client: ReturnType<typeof createClient>;
let db: LibSQLDatabase<Record<string, unknown>>;

const SOON = Math.floor(Date.now() / 1000) + 86_400;

function event(overrides: Partial<MobilizeEvent> = {}): MobilizeEvent {
	return {
		id: 501,
		title: 'Partner canvass',
		event_type: 'CANVASS',
		browser_url: 'https://www.mobilize.us/partner/event/501/',
		visibility: 'PUBLIC',
		address_visibility: 'PUBLIC',
		description: 'Join us.',
		tags: [{ id: 9, name: 'Shared Shift' }],
		sponsor: { id: 42 },
		is_virtual: false,
		timeslots: [{ id: 1, start_date: SOON, end_date: SOON + 3600 }],
		location: {
			venue: 'Hall',
			address_lines: ['1 Main St'],
			locality: 'Flint',
			region: 'MI',
			postal_code: '48502',
		},
		...overrides,
	};
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	await client.execute(
		"INSERT INTO zip_chapter_map (zip_code, chapter_id, member_count, updated_at) VALUES ('48502', 77, 3, 'x')",
	);
	Object.assign(env, {
		MOBILIZE_IMPORT_API_KEY: 'partner-key',
		MOBILIZE_IMPORT_ORG_ID: 42,
		SOLIDARITY_DEFAULT_CHAPTER_ID: 1,
	});
	settings.mobilizeImportTag = 'shared shift';
	listUpcomingOrgEvents.mockReset();
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	client.close();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('runMobilizeImport', () => {
	it('is not configured without the partner key, and reads nothing', async () => {
		env.MOBILIZE_IMPORT_API_KEY = '';
		expect(await runMobilizeImport(db as never)).toMatchObject({ configured: false });
		expect(listUpcomingOrgEvents).not.toHaveBeenCalled();
	});

	it('is not configured without a valid partner org id', async () => {
		env.MOBILIZE_IMPORT_ORG_ID = NaN;
		expect(await runMobilizeImport(db as never)).toMatchObject({ configured: false });
	});

	it('is not configured without a tag on /settings', async () => {
		settings.mobilizeImportTag = '';
		expect(await runMobilizeImport(db as never)).toEqual({
			configured: false,
			reason: 'no import tag set on /settings',
		});
	});

	it('refuses to run without a default chapter', async () => {
		env.SOLIDARITY_DEFAULT_CHAPTER_ID = 0;
		await expect(runMobilizeImport(db as never)).rejects.toThrow(/SOLIDARITY_DEFAULT_CHAPTER_ID/);
	});

	it('reads the PARTNER org with the partner key', async () => {
		listUpcomingOrgEvents.mockResolvedValue([]);
		await runMobilizeImport(db as never, { apply: false });
		expect(listUpcomingOrgEvents).toHaveBeenCalledWith({ apiKey: 'partner-key', orgId: 42 });
	});

	it('reports a rejected partner key instead of throwing', async () => {
		listUpcomingOrgEvents.mockRejectedValue(new MobilizeError('nope', 403, ''));
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		expect(await runMobilizeImport(db as never)).toMatchObject({
			configured: true,
			mobilizeAuthFailed: true,
			created: 0,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('lets any other Mobilize failure throw', async () => {
		listUpcomingOrgEvents.mockRejectedValue(new MobilizeError('down', 502, ''));
		await expect(runMobilizeImport(db as never)).rejects.toThrow('down');
	});

	it('plans from the zip map and counts what it skipped, on a dry run', async () => {
		listUpcomingOrgEvents.mockResolvedValue([
			event(),
			event({ id: 502, visibility: 'PRIVATE' }),
			event({ id: 503, sponsor: { id: 7 } }),
		]);
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const result = await runMobilizeImport(db as never, { apply: false });
		expect(result).toMatchObject({
			configured: true,
			dryRun: true,
			planned: 1,
			wouldCreate: ['Partner canvass'],
			fallbackScope: [],
			skippedNotPublic: 1,
			skippedNotOwned: 1,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('creates into the zip’s chapter and records the import against the partner org', async () => {
		listUpcomingOrgEvents.mockResolvedValue([event()]);
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				bodies.push(JSON.parse(init.body as string));
				return url.endsWith('/events')
					? Response.json({ data: { id: 900, event_sessions: [{ id: 5 }] } })
					: Response.json({ data: { id: 900, event_page_url: 'https://p/900' } }, { status: 201 });
			}),
		);
		const result = await runMobilizeImport(db as never);
		expect(result).toMatchObject({ created: 1, failed: 0 });
		expect(bodies[0]).toMatchObject({ scope_id: 77, scope_type: 'Chapter' });
		const rows = await client.execute(
			'SELECT source_org_id, solidarity_event_id, status FROM mobilize_imported_events',
		);
		expect(rows.rows[0]).toMatchObject({
			source_org_id: 42,
			solidarity_event_id: 900,
			status: 'complete',
		});
	});
});

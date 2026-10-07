// Partner-org Mobilize -> Solidarity event import, server side: gathers the
// inputs runImport needs ($env, settings, the zip map) and hands it the ledger.
//
// The partner tags events in their own Mobilize org; every public, upcoming,
// tagged event is copied once into our Solidarity with an event page. See
// mobilize-migrator/lib/import.ts for the write loop and import-transform.ts for
// the mapping.

import type { drizzle } from 'drizzle-orm/libsql';

import {
	emptyImportReport,
	runImport,
	type ImportReport,
} from '../../../mobilize-migrator/lib/import.js';
import { planImport } from '../../../mobilize-migrator/lib/import-transform.js';
import { listUpcomingOrgEvents, MobilizeError } from '../../../mobilize-migrator/lib/mobilize.js';
import { loadMobilizeImportApi } from './mobilize-api.js';
import { TursoImportLedger } from './mobilize-import-ledger.js';
import { loadSettings } from './settings.js';
import { zipChapterMap } from './schema.js';
import {
	MOBILIZE_IMPORT_MAX_CREATES,
	SOLIDARITY_API_TOKEN,
	SOLIDARITY_DEFAULT_CHAPTER_ID,
} from './env.js';

type Db = ReturnType<typeof drizzle>;

/** Same reasoning as mobilize-sync.ts's budget: one request must finish well
 *  inside what fly-proxy tolerates, and the caller re-posts while
 *  `incomplete`. */
const DEFAULT_BUDGET_MS = 120_000;

export interface MobilizeImportOptions {
	apply?: boolean;
	maxCreates?: number;
	budgetMs?: number;
}

export type MobilizeImportResult =
	| { configured: false; reason: string }
	| (ImportReport & {
			configured: true;
			/** The partner's Mobilize rejected the key while listing events. */
			mobilizeAuthFailed: boolean;
			/** Tagged but private or unlisted — never imported. */
			skippedNotPublic: number;
			/** Tagged, but owned by an org the partner only promotes. */
			skippedNotOwned: number;
			dryRun: boolean;
	  });

export async function runMobilizeImport(
	db: Db,
	options: MobilizeImportOptions = {},
): Promise<MobilizeImportResult> {
	const apply = options.apply ?? true;
	const budgetMs =
		Number.isFinite(options.budgetMs) && (options.budgetMs as number) > 0
			? (options.budgetMs as number)
			: DEFAULT_BUDGET_MS;
	const writeDeadline = Date.now() + budgetMs;

	const settings = await loadSettings(db);
	const tagName = settings.mobilizeImportTag;
	const api = loadMobilizeImportApi();
	// Not an error: the import is opt-in, and an install without a partner org
	// runs this job every hour.
	if (!api) {
		return {
			configured: false,
			reason: 'MOBILIZE_IMPORT_API_KEY / MOBILIZE_IMPORT_ORG_ID are not set',
		};
	}
	if (!tagName) return { configured: false, reason: 'no import tag set on /settings' };
	// Configured but unable to place a single event: that one IS an error.
	if (SOLIDARITY_DEFAULT_CHAPTER_ID <= 0) {
		throw new Error(
			'SOLIDARITY_DEFAULT_CHAPTER_ID is not set — the import needs it for virtual events ' +
				'and for in-person events whose zip has no chapter',
		);
	}

	let events;
	try {
		events = await listUpcomingOrgEvents(api);
	} catch (err) {
		if (err instanceof MobilizeError && (err.status === 401 || err.status === 403)) {
			return {
				...emptyImportReport(),
				configured: true,
				mobilizeAuthFailed: true,
				skippedNotPublic: 0,
				skippedNotOwned: 0,
				dryRun: !apply,
			};
		}
		throw err;
	}

	const zipRows = await db
		.select({ zipCode: zipChapterMap.zipCode, chapterId: zipChapterMap.chapterId })
		.from(zipChapterMap);
	const { planned, skipped } = planImport(events, {
		tagName,
		sourceOrgId: api.orgId,
		now: Math.floor(Date.now() / 1000),
		zipChapters: new Map(zipRows.map((r) => [r.zipCode, r.chapterId])),
		defaultChapterId: SOLIDARITY_DEFAULT_CHAPTER_ID,
	});

	const report = await runImport(
		planned,
		{
			solidarityToken: SOLIDARITY_API_TOKEN,
			maxCreatesPerRun: options.maxCreates ?? MOBILIZE_IMPORT_MAX_CREATES,
			apply,
			writeDeadline,
			log: (message) => console.log(`[mobilize-import] ${message}`),
		},
		new TursoImportLedger(db, api.orgId),
	);

	return {
		...report,
		configured: true,
		mobilizeAuthFailed: false,
		skippedNotPublic: skipped.filter((s) => s.reason === 'not-public').length,
		skippedNotOwned: skipped.filter((s) => s.reason === 'not-owned').length,
		dryRun: !apply,
	};
}

/**
 * Which turf a MiniVAN list number belongs to.
 *
 * Read-only, and it makes no VAN call. Three places hold a list number, and a
 * number can outlive the first of them:
 *
 *   - van_turfs.printed_list_number: the turf's list as of its last sync. A
 *     re-cut retires the row but keeps the number, so a list from before a
 *     region was regenerated still finds its old cut — and through that, by
 *     region and name, the live turf that replaced it (see vanTurfs in
 *     schema.ts). A list regenerated on the same route overwrites it.
 *   - van_turf_checkouts.issued_list_number: what a volunteer was told when
 *     they claimed the turf. Survives a regeneration.
 *   - van_minivan_exports.list_number: each time someone loaded the number in
 *     MiniVAN. Names the canvasser but not the turf, and is pruned at 45 days.
 *
 * Usage (from project root):
 *   npm run van:list -- 60942593-88543
 *
 * Required env vars:
 *   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (unless the URL starts with file:)
 */

import { createClient } from '@libsql/client';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { dbConfig } from '../bin/db-config.js';
import { campaignSheetStamp } from '../src/lib/campaign-time.js';
import { vanMinivanExports, vanTurfCheckouts, vanTurfs } from '../src/lib/server/schema.js';

const listNumber = process.argv
	.slice(2)
	.join(' ')
	.trim()
	.replace(/^List\s+/i, '');
if (!listNumber) {
	console.error('Usage: npm run van:list -- <MiniVAN list number>');
	process.exit(1);
}

const db = drizzle(createClient(dbConfig));

function turfLine(t: {
	turfId: number;
	campaignId: number;
	name: string;
	regionName: string;
	chapterName: string;
	retiredAt: string | null;
}): string {
	const state = t.retiredAt ? `retired ${campaignSheetStamp(t.retiredAt)}` : 'LIVE';
	const where = [t.chapterName, t.regionName].filter(Boolean).join(' / ');
	return `${t.name}  (turf ${t.turfId} · campaign ${t.campaignId} · ${state}${where ? ` · ${where}` : ''})`;
}

const turfColumns = {
	turfId: vanTurfs.turfId,
	campaignId: vanTurfs.campaignId,
	name: vanTurfs.name,
	regionName: vanTurfs.regionName,
	chapterName: vanTurfs.chapterName,
	retiredAt: vanTurfs.retiredAt,
};

async function main(): Promise<void> {
	const [current, issued, exports] = await Promise.all([
		db
			.select({ ...turfColumns, createdAt: vanTurfs.printedListCreatedAt })
			.from(vanTurfs)
			.where(eq(vanTurfs.printedListNumber, listNumber)),
		db
			.select({
				...turfColumns,
				slackUserName: vanTurfCheckouts.slackUserName,
				claimedAt: vanTurfCheckouts.claimedAt,
				currentListNumber: vanTurfs.printedListNumber,
			})
			.from(vanTurfCheckouts)
			.innerJoin(vanTurfs, eq(vanTurfs.turfId, vanTurfCheckouts.turfId))
			.where(eq(vanTurfCheckouts.issuedListNumber, listNumber))
			.orderBy(asc(vanTurfCheckouts.claimedAt)),
		db
			.select({
				campaignId: vanMinivanExports.campaignId,
				dateCreated: vanMinivanExports.dateCreated,
				canvassersJson: vanMinivanExports.canvassersJson,
			})
			.from(vanMinivanExports)
			.where(eq(vanMinivanExports.listNumber, listNumber))
			.orderBy(asc(vanMinivanExports.dateCreated)),
	]);

	console.log(`\nList ${listNumber}`);

	if (current.length > 0) {
		console.log('\n  Turf whose printed list this is:');
		for (const t of current) {
			const created = t.createdAt ? ` · list generated ${campaignSheetStamp(t.createdAt)}` : '';
			console.log(`    ${turfLine(t)}${created}`);
		}
	}

	// A list from an earlier cut: the ground it covered is now whatever live
	// route carries the same name in the same region.
	const retired = new Map<string, { campaignId: number; regionName: string; name: string }>();
	for (const t of [...current, ...issued]) {
		if (t.retiredAt) retired.set(`${t.campaignId}|${t.regionName}|${t.name}`, t);
	}
	if (retired.size > 0) {
		console.log('\n  That cut has been retired. Live turf with the same name now:');
		for (const t of retired.values()) {
			const live = await db
				.select({ ...turfColumns, listNumber: vanTurfs.printedListNumber })
				.from(vanTurfs)
				.where(
					and(
						eq(vanTurfs.campaignId, t.campaignId),
						eq(vanTurfs.regionName, t.regionName),
						eq(vanTurfs.name, t.name),
						isNull(vanTurfs.retiredAt),
					),
				);
			if (live.length === 0) {
				console.log(`    none for ${t.name} — VAN dropped or renamed it in the re-cut`);
			}
			for (const l of live) {
				console.log(`    ${turfLine(l)} · list ${l.listNumber ?? 'not generated yet'}`);
			}
		}
	}

	if (issued.length > 0) {
		console.log('\n  Issued to volunteers with a claim on:');
		for (const c of issued) {
			const stale =
				c.currentListNumber !== listNumber
					? ` · turf's list is now ${c.currentListNumber ?? 'none'}`
					: '';
			console.log(`    ${turfLine(c)}`);
			console.log(`      ${campaignSheetStamp(c.claimedAt)}  ${c.slackUserName}${stale}`);
		}
	}

	if (exports.length > 0) {
		console.log('\n  Loaded in MiniVAN:');
		for (const e of exports) {
			let names = '';
			try {
				const canvassers = JSON.parse(e.canvassersJson) as Array<{
					firstName?: string;
					lastName?: string;
				}>;
				names = canvassers
					.map((c) => [c.firstName, c.lastName].filter(Boolean).join(' '))
					.filter(Boolean)
					.join(', ');
			} catch {
				// Kept verbatim from VAN; a shape we can't read just goes unnamed.
			}
			// dateCreated is VAN's campaign-local wall clock with a Z, so it is
			// shown as written rather than converted.
			console.log(
				`    ${e.dateCreated ?? '?'}  campaign ${e.campaignId}  ${names || 'unknown canvasser'}`,
			);
		}
	}

	if (current.length === 0 && issued.length === 0) {
		console.log(
			exports.length > 0
				? '\n  → Loaded in MiniVAN, but no turf here has ever had this number. Likely generated in VAN directly, or before this app synced its turf.'
				: '\n  → No turf, claim, or MiniVAN export has this number. Check for a typo; exports older than 45 days are pruned.',
		);
	}
	console.log('');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

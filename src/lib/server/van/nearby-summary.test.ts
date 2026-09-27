import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { loadNearbySummary, loadTurfCentre } from './nearby-summary.js';
import { CANVASSER_LEVELS } from '../../van/nearby-summary.js';

// Real in-memory SQLite with the real migrations, so the column names and the
// bounding-box filter are exercised as they run in production.

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-09-25T18:00:00.000Z');
const HOUR = 3600 * 1000;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

const HERE = { lat: 42.2808, lng: -83.743 };
/** About a mile north of HERE: inside the 2-mile ring. */
const NEAR = { lat: 42.2953, lng: -83.743 };
/** About 2.5 miles north: outside the ring, inside the 3-mile grid. */
const EDGE = { lat: 42.317, lng: -83.743 };
/** Far away: in neither. */
const FAR = { lat: 42.9, lng: -83.743 };

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
});

async function turf(
	id: number,
	at: { lat: number; lng: number } | null,
	over: {
		doors?: number;
		retired?: boolean;
		vanAssignedAt?: string | null;
		vanDistributedTo?: string | null;
		sheetAssignedTo?: string | null;
		listNumber?: string | null;
	} = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turfs
		        (map_route_id, map_region_id, folder_id, chapter_id, name, door_count,
		         printed_list_number, van_distributed_to, sheet_assigned_to,
		         centroid_lat, centroid_lng, retired_at, van_assigned_at, first_seen_at, last_seen_at)
		      VALUES (?, 1, 1, 71, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			id,
			`Turf ${id}`,
			over.doors ?? 100,
			over.listNumber === undefined ? `L-${id}` : over.listNumber,
			over.vanDistributedTo ?? null,
			over.sheetAssignedTo ?? null,
			at?.lat ?? null,
			at?.lng ?? null,
			over.retired ? iso(-HOUR) : null,
			over.vanAssignedAt ?? null,
			iso(-24 * HOUR * 30),
			iso(0),
		],
	});
}

async function claim(
	mapRouteId: number,
	slackUserId: string,
	over: {
		expiresAt?: string;
		releasedAt?: string | null;
		completedAt?: string | null;
		releaseReason?: string | null;
		reportedPercent?: number | null;
	} = {},
) {
	await client.execute({
		sql: `INSERT INTO van_turf_checkouts
		        (map_route_id, slack_user_id, slack_user_name, claimed_at, expires_at,
		         released_at, completed_at, release_reason, reported_percent)
		      VALUES (?, ?, 'Someone', ?, ?, ?, ?, ?, ?)`,
		args: [
			mapRouteId,
			slackUserId,
			iso(-2 * HOUR),
			over.expiresAt ?? iso(24 * HOUR),
			over.releasedAt ?? null,
			over.completedAt ?? null,
			over.releaseReason ?? null,
			over.reportedPercent ?? null,
		],
	});
}

const level = (label: string) => CANVASSER_LEVELS.findIndex((l) => l.label === label);

describe('loadNearbySummary', () => {
	it('counts doors inside the ring only, floored to 50', async () => {
		await turf(1, HERE, { doors: 250 });
		await turf(2, NEAR, { doors: 122 });
		await turf(3, EDGE, { doors: 900 });
		await turf(4, FAR, { doors: 900 });
		const summary = await loadNearbySummary(db, HERE, NOW);
		expect(summary.doors).toEqual({ kind: 'over', atLeast: 350 });
	});

	it('counts only doors nobody has taken', async () => {
		await turf(1, HERE, { doors: 120 });
		// Each of these is taken, one way or another.
		await turf(2, HERE, { doors: 1000 });
		await claim(2, 'U_HOLDER');
		await turf(3, HERE, { doors: 1000, vanDistributedTo: 'A canvasser' });
		await turf(4, HERE, { doors: 1000, sheetAssignedTo: 'Someone on the tracker' });
		await turf(5, HERE, { doors: 1000, listNumber: null });
		await turf(6, HERE, { doors: 1000 });
		await claim(6, 'U_FINISHED', { completedAt: iso(-72 * HOUR), reportedPercent: 100 });
		const summary = await loadNearbySummary(db, HERE, NOW);
		expect(summary.doors).toEqual({ kind: 'over', atLeast: 100 });
	});

	it('counts a turf again once its claim has lapsed', async () => {
		await turf(1, HERE, { doors: 120 });
		await claim(1, 'U_LAPSED', { expiresAt: iso(-HOUR) });
		const summary = await loadNearbySummary(db, HERE, NOW);
		expect(summary.doors).toEqual({ kind: 'over', atLeast: 100 });
	});

	it('says "all taken" rather than "no turf" when every nearby turf is spoken for', async () => {
		await turf(1, HERE, { doors: 300 });
		await claim(1, 'U_HOLDER');
		const summary = await loadNearbySummary(db, HERE, NOW);
		expect(summary.doors).toEqual({ kind: 'all-taken' });
		// The map still shows where that turf is.
		expect(summary.cells.length).toBeGreaterThan(0);
	});

	it('leaves out retired turf and turf with no location', async () => {
		await turf(1, HERE, { doors: 250, retired: true });
		await turf(2, null, { doors: 250 });
		const summary = await loadNearbySummary(db, HERE, NOW);
		expect(summary.doors).toEqual({ kind: 'none' });
		expect(summary.cells).toEqual([]);
	});

	it('draws the grid past the ring, but not past its own radius', async () => {
		await turf(3, EDGE, { doors: 300 });
		await turf(4, FAR, { doors: 300 });
		const summary = await loadNearbySummary(db, HERE, NOW);
		expect(summary.cells).toHaveLength(1);
	});

	it('counts each person once, however many turfs they hold', async () => {
		await turf(1, HERE);
		await turf(2, NEAR);
		await claim(1, 'U_A');
		await claim(2, 'U_A');
		await claim(1, 'U_B', { completedAt: iso(-HOUR) });
		const summary = await loadNearbySummary(db, HERE, NOW);
		expect(summary.canvassers).toBe(level('A couple'));
	});

	it('counts a recent walk and a recent walk-out, but not old or abandoned claims', async () => {
		await turf(1, HERE);
		await claim(1, 'U_DONE', { completedAt: iso(-3 * HOUR) });
		await claim(1, 'U_WALKED_OUT', {
			releasedAt: iso(-3 * HOUR),
			releaseReason: 'walked-out',
		});
		await claim(1, 'U_OLD', { completedAt: iso(-30 * HOUR) });
		await claim(1, 'U_GAVE_UP', { releasedAt: iso(-HOUR), releaseReason: 'volunteer' });
		await claim(1, 'U_LAPSED', { expiresAt: iso(-HOUR) });
		const summary = await loadNearbySummary(db, HERE, NOW);
		expect(summary.canvassers).toBe(level('A couple'));
	});

	it('counts a recent hand-out in VAN as one person, and ignores an old one', async () => {
		await turf(1, HERE, { vanAssignedAt: iso(-HOUR) });
		await turf(2, NEAR, { vanAssignedAt: iso(-48 * HOUR) });
		const summary = await loadNearbySummary(db, HERE, NOW);
		expect(summary.canvassers).toBe(level('A couple'));
	});

	it('does not count people on turf outside the ring', async () => {
		await turf(3, EDGE);
		await claim(3, 'U_EDGE');
		const summary = await loadNearbySummary(db, HERE, NOW);
		expect(summary.canvassers).toBe(level('No one'));
	});

	it('returns only coarse fields', async () => {
		await turf(1, HERE, { doors: 272 });
		await claim(1, 'U_A');
		const summary = await loadNearbySummary(db, { lat: 42.2808123, lng: -83.7430987 }, NOW);
		expect(Object.keys(summary).sort()).toEqual(['canvassers', 'cells', 'centre', 'doors']);
		expect(summary.centre).toEqual({ lat: 42.281, lng: -83.743 });
		const serialised = JSON.stringify(summary);
		expect(serialised).not.toContain('U_A');
		expect(serialised).not.toContain('Turf 1');
		expect(serialised).not.toContain('272');
	});
});

describe('loadTurfCentre', () => {
	it('averages live turf to a tenth of a degree', async () => {
		await turf(1, { lat: 42.21, lng: -83.71 });
		await turf(2, { lat: 42.39, lng: -83.83 });
		await turf(3, { lat: 10, lng: 10 }, { retired: true });
		expect(await loadTurfCentre(db)).toEqual({ lat: 42.3, lng: -83.8 });
	});

	it('is null with no mapped turf', async () => {
		await turf(1, null);
		expect(await loadTurfCentre(db)).toBeNull();
	});
});

// The van_campaigns rows as the sync uses them: which campaigns to run and in
// what order, what to call each in a message, whether one may be re-cut, and
// what its last failure was (specs/012-multi-van-campaigns/spec.md).
//
// Credentials are not here — van-env.ts resolves a campaign's client from its
// `VAN_CAMPAIGN_<KEY>` secret. This is only the database side.

import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { vanCampaigns, vanSyncState, vanTurfs, type VanCampaignRow } from '../schema.js';

// The widest handle these need, so the scheduler — which holds its own,
// loosely typed one — can call them as well as the routes.
type Db = LibSQLDatabase<Record<string, unknown>>;

/** What to call a campaign in a message: its label, or its credential key
 *  until an admin names it. */
export function campaignName(campaign: Pick<VanCampaignRow, 'label' | 'credentialKey'>): string {
	return campaign.label?.trim() || campaign.credentialKey;
}

/**
 * Whether the sync may ask VAN to re-cut this campaign's regions.
 *
 * A re-cut deletes the region's printed lists and replaces every route, so it
 * is the one thing this app does that changes a campaign's own VAN data — and a
 * campaign has to agree to it. Each campaign has its own switch on its settings
 * page, off unless an admin turns it on: at least one partner campaign has said
 * no, and a campaign nobody has asked must be treated the same way. Strictly
 * true — anything a hand edit leaves behind is off.
 */
export function regionRefreshAllowed(campaign: Pick<VanCampaignRow, 'refreshEnabled'>): boolean {
	return campaign.refreshEnabled === true;
}

/**
 * The campaign a settings request names, or why it can't be used: the request
 * body's `campaignId` must be a positive integer naming a campaign that
 * exists. For the routes that edit one campaign's folders or sheet rules.
 */
export async function campaignFromRequest(
	db: Db,
	raw: unknown,
): Promise<
	{ ok: true; campaign: VanCampaignRow } | { ok: false; status: 400 | 404; error: string }
> {
	if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
		return { ok: false, status: 400, error: 'campaignId must be a positive integer' };
	}
	const campaign = await loadCampaign(db, raw);
	if (!campaign) return { ok: false, status: 404, error: `No campaign ${raw}` };
	return { ok: true, campaign };
}

export async function loadCampaign(db: Db, campaignId: number): Promise<VanCampaignRow | null> {
	const [row] = await db.select().from(vanCampaigns).where(eq(vanCampaigns.id, campaignId));
	return row ?? null;
}

/**
 * Enabled campaigns, the one synced longest ago first — never-synced before
 * all of them.
 *
 * The order a request with no campaign named works through them in. A request
 * that runs out of time leaves the rest for the next one, and they are then
 * the stalest, so every campaign is reached within a few runs rather than the
 * first in the table being synced every time and the last never.
 */
export async function campaignsStalestFirst(db: Db): Promise<VanCampaignRow[]> {
	const rows = await db
		.select({ campaign: vanCampaigns })
		.from(vanCampaigns)
		.leftJoin(vanSyncState, eq(vanSyncState.campaignId, vanCampaigns.id))
		.where(eq(vanCampaigns.enabled, true))
		.orderBy(
			sql`${vanSyncState.lastSyncAt} is not null`,
			asc(vanSyncState.lastSyncAt),
			asc(vanCampaigns.id),
		);
	return rows.map((r) => r.campaign);
}

/**
 * Record why a campaign's sync failed, and say whether this failure still
 * needs announcing.
 *
 * True only when the error differs from the one already posted to Slack
 * (`alertedError`) — the same idempotency shape as van_sheet_health, for the
 * same reason: an alert that repeats every half hour gets the channel muted. A
 * successful sync clears both columns (sync.ts), so a recurrence is announced.
 */
export async function recordSyncFailure(
	db: Db,
	campaignId: number,
	error: string,
): Promise<boolean> {
	const lastError = error.slice(0, 500);
	await db
		.insert(vanSyncState)
		.values({ campaignId, lastError })
		.onConflictDoUpdate({ target: vanSyncState.campaignId, set: { lastError } });
	const [row] = await db
		.select({ alertedError: vanSyncState.alertedError })
		.from(vanSyncState)
		.where(eq(vanSyncState.campaignId, campaignId));
	return row?.alertedError !== lastError;
}

/** Stamp a failure as announced, once Slack has accepted the message. Only
 *  while it is still the current failure: a success in between cleared it. */
export async function markFailureAnnounced(
	db: Db,
	campaignId: number,
	error: string,
): Promise<void> {
	const lastError = error.slice(0, 500);
	await db
		.update(vanSyncState)
		.set({ alertedError: lastError })
		.where(and(eq(vanSyncState.campaignId, campaignId), eq(vanSyncState.lastError, lastError)));
}

/** Whether more than one campaign is enabled. Messages name their campaign
 *  only then, so a single-campaign install reads exactly as it always has. */
export async function severalCampaignsEnabled(db: Db): Promise<boolean> {
	const rows = await db
		.select({ id: vanCampaigns.id })
		.from(vanCampaigns)
		// The same test campaignsStalestFirst uses, so "several" means several
		// of the campaigns actually being synced.
		.where(eq(vanCampaigns.enabled, true))
		.limit(2);
	return rows.length > 1;
}

/** The enabled campaigns by whether the sync re-cuts their regions, by name —
 *  for pages that explain why door counts move (or don't), where one switch
 *  for everyone would be wrong about half the turf. */
export async function campaignRefreshSwitches(db: Db): Promise<{ on: string[]; off: string[] }> {
	const rows = await db
		.select()
		.from(vanCampaigns)
		.where(eq(vanCampaigns.enabled, true))
		.orderBy(asc(vanCampaigns.id));
	return {
		on: rows.filter((c) => regionRefreshAllowed(c)).map(campaignName),
		off: rows.filter((c) => !regionRefreshAllowed(c)).map(campaignName),
	};
}

/** Turf whose campaign is enabled. A disabled campaign's turf is not handed
 *  out, so every count or list of turf someone could take uses this. */
export function turfCampaignEnabled(): SQL {
	return sql`${vanTurfs.campaignId} in (
		select ${vanCampaigns.id} from ${vanCampaigns} where ${vanCampaigns.enabled} = 1
	)`;
}

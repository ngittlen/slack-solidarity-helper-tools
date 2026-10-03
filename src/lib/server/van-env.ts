// Env → the VAN client, and the only file in the app that knows VAN
// credentials exist. Everything under src/lib/server/van/ takes an injected
// client, so this is the single seam where configuration meets the network.
//
// Shaped exactly like door-knock-env.ts: a discriminated result rather than a
// throw, because the app must run normally with VAN unconfigured. A dashboard
// that 500s because nobody has finished the EveryAction security review is a
// worse outcome than a turf page that says "not configured yet".
//
// There can be several VAN campaigns, each a van_campaigns row whose
// credentials are its `VAN_CAMPAIGN_<KEY>` secret. `vanClientFor`
// is the per-campaign seam: every caller names the campaign it is working for.
//
// Note there is no VAN_TURF_FOLDER_IDS. Folder ids come from the
// van_chapter_folders table, edited in /settings — turf has to be attributed
// to a chapter to be servable at all (see plan.md §3), so an env var listing
// folders would be a second, conflicting source of truth.

import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { VAN_EXPORT_JOB_TYPE_ID, VAN_ID_HASH_SECRET, vanCampaignCredentials } from './env.js';
import { vanCampaigns, type VanCampaignRow } from './schema.js';
import {
	campaignSecretName,
	exportJobTypeIdFor,
	PRIMARY_CAMPAIGN_KEY,
	VAN_CAMPAIGN_PREFIX,
} from './van/campaign-credentials.js';
import { createVanClient, type VanClient } from './van/client.js';
import { createPersonHasher, type PersonHasher } from './van/person-hash.js';

type Db = ReturnType<typeof drizzle>;

/** `missing` is true when the campaign has no secret at all, as opposed to one
 *  that is malformed. An install that never set VAN up is the former, and the
 *  sync stays quiet about it rather than alerting on every run. */
export type VanClientResult =
	{ ok: true; client: VanClient } | { ok: false; error: string; missing?: boolean };

/** A campaign's VAN client, or why there isn't one.
 *
 *  A fresh client per call, as vanClient() has always returned. Each client
 *  carries its own concurrency cap, so caching one per campaign would make the
 *  catalog sync and the contact pull — which run side by side — share two
 *  request slots instead of having two each. Building one is free: there is
 *  no token to mint, the credentials go in every request's Basic header. */
export function vanClientFor(campaign: Pick<VanCampaignRow, 'credentialKey'>): VanClientResult {
	const key = campaign.credentialKey;
	const { credentials, errors } = vanCampaignCredentials();
	const credential = credentials.get(key);
	if (!credential) {
		const error = errors.get(key);
		if (error) return { ok: false, error };
		return {
			ok: false,
			missing: true,
			error:
				key === PRIMARY_CAMPAIGN_KEY
					? `${campaignSecretName(key)} (or VAN_APP_NAME/VAN_API_KEY) is not set`
					: `${campaignSecretName(key)} is not set`,
		};
	}
	return {
		ok: true,
		client: createVanClient({
			appName: credential.appName,
			apiKey: credential.apiKey,
			databaseMode: credential.databaseMode,
		}),
	};
}

/**
 * What the settings page may say about a campaign's credentials — and nothing
 * more. The API key is deliberately not in this shape, so no page or response
 * built from it can carry the key.
 */
export interface CredentialStatus {
	/** The env var that holds them, e.g. `VAN_CAMPAIGN_OTHER`. */
	secretName: string;
	/** `ok`: usable. `missing`: no secret at all. `invalid`: a secret that
	 *  fails to parse — `error` says how, by name, never by value. */
	state: 'ok' | 'missing' | 'invalid';
	error: string | null;
	appName: string | null;
	databaseMode: 0 | 1 | null;
	/** `legacy` when the primary campaign is still on VAN_APP_NAME/VAN_API_KEY. */
	source: 'secret' | 'legacy' | null;
}

export function credentialStatus(
	campaign: Pick<VanCampaignRow, 'credentialKey'>,
): CredentialStatus {
	const key = campaign.credentialKey;
	const { credentials, errors } = vanCampaignCredentials();
	const secretName = campaignSecretName(key);
	const credential = credentials.get(key);
	if (credential) {
		return {
			secretName,
			state: 'ok',
			error: null,
			appName: credential.appName,
			databaseMode: credential.databaseMode,
			source: credential.source,
		};
	}
	const error = errors.get(key) ?? null;
	return {
		secretName,
		state: error ? 'invalid' : 'missing',
		error,
		appName: null,
		databaseMode: null,
		source: null,
	};
}

/** A campaign's geometry export job type, or null when it has none — which
 *  turns geometry off for that campaign, not the catalog.
 *
 *  'primary' falls back to VAN_EXPORT_JOB_TYPE_ID, so an install configured
 *  before campaigns existed keeps its geometry without anyone re-entering it. */
export function vanExportJobTypeIdFor(
	campaign: Pick<VanCampaignRow, 'credentialKey' | 'exportJobTypeId'>,
): number | null {
	return exportJobTypeIdFor(campaign, legacyExportJobTypeId());
}

/**
 * Give every campaign secret a van_campaigns row, so a new campaign shows up
 * in /settings to be configured.
 *
 * New rows are DISABLED: setting a secret is not consent to start syncing, and
 * its folders still have to be mapped. Idempotent — an existing row, enabled
 * or not, is never touched. A secret that fails to parse still gets a row, so
 * the settings page can show the campaign with its error.
 *
 * Returns the keys it created rows for.
 */
export async function ensureCampaignRows(db: Db, now = new Date()): Promise<string[]> {
	const { credentials, errors } = vanCampaignCredentials();
	// A secret whose NAME is malformed is listed under that name rather than a
	// campaign key, and has no campaign to make a row for.
	const keys = new Set([
		...credentials.keys(),
		...[...errors.keys()].filter((key) => !key.startsWith(VAN_CAMPAIGN_PREFIX)),
	]);
	if (keys.size === 0) return [];

	const existing = new Set(
		(await db.select({ key: vanCampaigns.credentialKey }).from(vanCampaigns)).map((r) => r.key),
	);
	const created: string[] = [];
	for (const key of keys) {
		if (existing.has(key)) continue;
		const inserted = await db
			.insert(vanCampaigns)
			// No label: an admin names the campaign in /settings. Leaving it
			// blank is also what keeps this insert from ever colliding with a
			// label an admin already chose for another campaign.
			.values({
				credentialKey: key,
				enabled: false,
				lastEditedBy: 'system',
				lastEditedByName: 'system',
				lastEditedAt: now.toISOString(),
			})
			// Targeted, so the only conflict it swallows is the one it is for: a
			// concurrent tick inserting the same key first.
			.onConflictDoNothing({ target: vanCampaigns.credentialKey })
			.returning({ key: vanCampaigns.credentialKey });
		if (inserted.length > 0) created.push(key);
	}
	return created;
}

/** Enabled campaigns, each with its client or why it has none. */
export async function enabledVanCampaigns(
	db: Db,
): Promise<Array<{ campaign: VanCampaignRow; client: VanClientResult }>> {
	const rows = await db
		.select()
		.from(vanCampaigns)
		.where(eq(vanCampaigns.enabled, true))
		.orderBy(vanCampaigns.id);
	return rows.map((campaign) => ({ campaign, client: vanClientFor(campaign) }));
}

/** The legacy VAN_EXPORT_JOB_TYPE_ID, which the primary campaign falls back
 *  to (vanExportJobTypeIdFor). Null when unset or unparseable. */
function legacyExportJobTypeId(): number | null {
	return Number.isFinite(VAN_EXPORT_JOB_TYPE_ID) && VAN_EXPORT_JOB_TYPE_ID > 0
		? VAN_EXPORT_JOB_TYPE_ID
		: null;
}

/** The VanID/door hasher for the uncontacted-door count, or null when
 *  VAN_ID_HASH_SECRET is unset — which turns the whole feature off. Global
 *  rather than per campaign: the tables it feeds are scoped by campaign. */
export function vanPersonHasher(): PersonHasher | null {
	return VAN_ID_HASH_SECRET ? createPersonHasher(VAN_ID_HASH_SECRET) : null;
}

// VAN credentials for every campaign, read out of the environment.
//
// One Fly secret per campaign, `VAN_CAMPAIGN_<KEY>`, holding a small JSON
// object (specs/012-multi-van-campaigns/spec.md):
//
//   VAN_CAMPAIGN_OTHER='{"appName":"…","apiKey":"…","databaseMode":0}'
//
// One secret per campaign rather than one array of them, so a typo while adding
// a campaign breaks that campaign and nothing else, and adding one never means
// re-pasting every other campaign's key. The suffix, lowercased, is the
// campaign's permanent identity — van_campaigns.credential_key links to it — so
// renaming a secret is creating a new campaign.
//
// Everything that is not a credential (label, folders, enabled) lives in the
// van_campaigns table. Keys never touch the database.
//
// Same import discipline as client.ts: no $env or $lib imports, the env record
// is passed in, so env.ts and the scripts under scripts/ (which run under tsx
// against process.env) share one parser.
//
// Same defensive shape as parseServiceAccount in google-env.ts: every way of
// getting a hand-pasted secret wrong names itself, and none of them throws —
// the app must boot with VAN half-configured. Error text names the SECRET and
// never quotes its value, which holds an API key.

import type { VanDatabaseMode } from './client.js';

export const VAN_CAMPAIGN_PREFIX = 'VAN_CAMPAIGN_';

/** The campaign the legacy VAN_APP_NAME/VAN_API_KEY/VAN_DATABASE_MODE vars
 *  stand in for. van_campaigns row 1 is seeded with this key. */
export const PRIMARY_CAMPAIGN_KEY = 'primary';

// Env var names, so uppercase. Capped well under any platform limit; a key is
// also a label default and an alert prefix, and a 200-character one is a typo.
const SUFFIX_PATTERN = /^[A-Z0-9_]{1,40}$/;

export interface VanCredential {
	/** The lowercased secret suffix — `VAN_CAMPAIGN_OTHER` → `other`. */
	key: string;
	appName: string;
	apiKey: string;
	databaseMode: VanDatabaseMode;
}

export interface VanCampaignCredentials {
	/** By key. */
	credentials: Map<string, VanCredential>;
	/** By key, for a secret that names a campaign but cannot be used. A secret
	 *  whose NAME is malformed has no key, so it is listed under its env name. */
	errors: Map<string, string>;
	/** Configuration that works but is probably not what was meant. */
	warnings: string[];
}

/** The env var that holds a campaign's credentials. */
export function campaignSecretName(key: string): string {
	return `${VAN_CAMPAIGN_PREFIX}${key.toUpperCase()}`;
}

/** Parse a database mode. Deliberately strict: '' and '2' are errors, not
 *  silent falls back to 0, because the wrong mode authenticates successfully
 *  and returns an empty-looking database — a failure that reads as "the
 *  campaign has no turf" rather than as a misconfiguration.
 *
 *  Accepts the string forms as well as numbers: a JSON secret may carry
 *  either, and the legacy env var is always a string. */
export function parseDatabaseMode(raw: unknown): VanDatabaseMode | null {
	if (raw === 0 || raw === '0') return 0;
	if (raw === 1 || raw === '1') return 1;
	return null;
}

const MODE_HINT = 'must be 0 (My Voters) or 1 (My Campaign)';

export type CampaignSecretResult =
	| {
			ok: true;
			appName: string;
			apiKey: string;
			/** Null only when `modeOptional` was set and the secret has none. */
			databaseMode: VanDatabaseMode | null;
	  }
	| { ok: false; error: string };

/**
 * Parse one secret's value.
 *
 * `modeOptional` is for scripts/van-check.ts, which probes both databases when
 * it is not told which one holds the turf — that is how the mode is found out
 * in the first place. Everywhere else the mode is required.
 */
export function parseCampaignSecret(
	name: string,
	raw: string,
	options: { modeOptional?: boolean } = {},
): CampaignSecretResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: `${name} is not valid JSON` };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {
			ok: false,
			error: `${name} must be a JSON object with appName, apiKey and databaseMode`,
		};
	}
	const fields = parsed as Record<string, unknown>;
	const appName = typeof fields.appName === 'string' ? fields.appName.trim() : '';
	const apiKey = typeof fields.apiKey === 'string' ? fields.apiKey.trim() : '';
	if (!appName) return { ok: false, error: `${name} has no appName` };
	if (!apiKey) return { ok: false, error: `${name} has no apiKey` };

	if (fields.databaseMode === undefined && options.modeOptional) {
		return { ok: true, appName, apiKey, databaseMode: null };
	}
	const databaseMode = parseDatabaseMode(fields.databaseMode);
	if (databaseMode === null) {
		// The value is not quoted back: it is harmless here, but a habit of
		// echoing secret fields is how an apiKey ends up in a log one day.
		return { ok: false, error: `${name} databaseMode ${MODE_HINT}` };
	}
	return { ok: true, appName, apiKey, databaseMode };
}

/** The legacy single-campaign vars, as the `primary` campaign. Messages are
 *  the ones van-env.ts has always given, so an operator who never adopts the
 *  new secrets sees nothing new. */
function parseLegacy(
	record: Record<string, string | undefined>,
): { ok: true; credential: VanCredential } | { ok: false; error: string } | null {
	const appName = record.VAN_APP_NAME ?? '';
	const apiKey = record.VAN_API_KEY ?? '';
	const rawMode = (record.VAN_DATABASE_MODE ?? '').trim();
	// A mode on its own configures nothing. .env.example ships
	// VAN_DATABASE_MODE=0 beside a blank key, and an install that never set
	// VAN up must boot without a warning about it.
	if (!appName && !apiKey) return null;
	if (!appName || !apiKey) {
		return { ok: false, error: 'VAN_APP_NAME/VAN_API_KEY are not set' };
	}
	const databaseMode = parseDatabaseMode(rawMode);
	if (databaseMode === null) {
		return {
			ok: false,
			error: `VAN_DATABASE_MODE ${MODE_HINT}, got "${rawMode}"`,
		};
	}
	return {
		ok: true,
		credential: { key: PRIMARY_CAMPAIGN_KEY, appName, apiKey, databaseMode },
	};
}

/**
 * Every campaign's credentials in an env record, and what is wrong with the
 * ones that cannot be used.
 *
 * Each secret stands alone: one malformed secret is one entry in `errors` and
 * every other campaign parses as normal.
 */
export function parseVanCampaigns(
	record: Record<string, string | undefined>,
): VanCampaignCredentials {
	const credentials = new Map<string, VanCredential>();
	const errors = new Map<string, string>();
	const warnings: string[] = [];

	for (const [name, raw] of Object.entries(record)) {
		if (!name.startsWith(VAN_CAMPAIGN_PREFIX) || raw === undefined) continue;
		const suffix = name.slice(VAN_CAMPAIGN_PREFIX.length);
		if (!SUFFIX_PATTERN.test(suffix)) {
			errors.set(
				name,
				`${name} is not a valid campaign secret name — the part after ` +
					`${VAN_CAMPAIGN_PREFIX} must be 1-40 uppercase letters, digits or underscores`,
			);
			continue;
		}
		const key = suffix.toLowerCase();
		const result = parseCampaignSecret(name, raw);
		if (!result.ok) {
			errors.set(key, result.error);
			continue;
		}
		credentials.set(key, {
			key,
			appName: result.appName,
			apiKey: result.apiKey,
			// parseCampaignSecret only returns null without modeOptional.
			databaseMode: result.databaseMode as VanDatabaseMode,
		});
	}

	const primaryName = campaignSecretName(PRIMARY_CAMPAIGN_KEY);
	const legacy = parseLegacy(record);
	if (record[primaryName] !== undefined) {
		if (legacy !== null) {
			warnings.push(
				`${primaryName} is set, so VAN_APP_NAME/VAN_API_KEY/VAN_DATABASE_MODE are ignored — ` +
					'unset them once the new secret is confirmed working',
			);
		}
	} else if (legacy?.ok) {
		credentials.set(PRIMARY_CAMPAIGN_KEY, legacy.credential);
	} else if (legacy && !legacy.ok) {
		errors.set(PRIMARY_CAMPAIGN_KEY, legacy.error);
	}

	return { credentials, errors, warnings };
}

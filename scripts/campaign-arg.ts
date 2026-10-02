/**
 * `--campaign <key>` for the VAN scripts: which campaign's key to use, and —
 * for the scripts that write — which van_campaigns row to write as.
 *
 * Credentials come from the same `VAN_CAMPAIGN_<KEY>` secrets the app reads
 * (src/lib/server/van/campaign-credentials.ts), with the legacy
 * VAN_APP_NAME/VAN_API_KEY/VAN_DATABASE_MODE standing in for `primary`, which
 * is also the default. So `npx tsx --env-file=.env.local scripts/x.ts` keeps
 * working exactly as before for the campaign the app has always served.
 */

import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import { vanCampaigns, type VanCampaignRow } from '../src/lib/server/schema.js';
import {
	campaignSecretName,
	parseVanCampaigns,
	PRIMARY_CAMPAIGN_KEY,
	type VanCredential,
} from '../src/lib/server/van/campaign-credentials.js';

type Db = ReturnType<typeof drizzle>;

/** The key named by `--campaign`, lowercased, or `primary`. Exits on a flag
 *  with no key after it. */
export function campaignKeyArg(argv: readonly string[] = process.argv.slice(2)): string {
	const i = argv.indexOf('--campaign');
	if (i < 0) return PRIMARY_CAMPAIGN_KEY;
	const value = argv[i + 1] ?? '';
	if (!value || value.startsWith('--')) {
		console.error('--campaign needs a key, e.g. --campaign other for VAN_CAMPAIGN_OTHER');
		process.exit(1);
	}
	return value.toLowerCase();
}

/** The campaign's credentials, or exit with what is wrong with them. */
export function campaignCredential(key: string): VanCredential {
	const { credentials, errors } = parseVanCampaigns(process.env);
	const credential = credentials.get(key);
	if (credential) return credential;
	console.error(
		errors.get(key) ??
			(key === PRIMARY_CAMPAIGN_KEY
				? `${campaignSecretName(key)} (or VAN_APP_NAME/VAN_API_KEY) is not set`
				: `${campaignSecretName(key)} is not set`),
	);
	process.exit(1);
}

/** The van_campaigns row for a key, or exit. The app creates it on its next
 *  sync after the secret is set; a script never invents one. */
export async function campaignRow(db: Db, key: string): Promise<VanCampaignRow> {
	const [row] = await db.select().from(vanCampaigns).where(eq(vanCampaigns.credentialKey, key));
	if (!row) {
		console.error(
			`No van_campaigns row for "${key}". The app adds one on its next sync after ` +
				`${campaignSecretName(key)} is set.`,
		);
		process.exit(1);
	}
	return row;
}

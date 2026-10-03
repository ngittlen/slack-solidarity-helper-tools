// How each VAN campaign reads in the /settings list: one chip for whether it is
// on, and one status for how its syncs are going. Pure — the loader gathers the
// facts, this decides what they say, so the rules can be tested without a
// database.

export type CampaignChip = 'enabled' | 'disabled' | 'new';

/** Worst first: credentials that can't be used — no secret, or one that does
 *  not parse — outrank a failing sync, which outranks one that has simply never
 *  run. */
export type CampaignHealth = 'no-credentials' | 'bad-credentials' | 'failing' | 'never' | 'ok';

export interface CampaignListRow {
	id: number;
	/** Label, or the credential key until an admin names it. */
	name: string;
	chip: CampaignChip;
	health: CampaignHealth;
	/** What went wrong, for the credential and failing states. Never the key —
	 *  credential errors name the secret, not its value. */
	detail: string | null;
	lastSyncAt: string | null;
	liveTurfs: number;
}

export interface CampaignListInput {
	id: number;
	name: string;
	enabled: boolean;
	disabledAt: string | null;
	credentialState: 'ok' | 'missing' | 'invalid';
	credentialError: string | null;
	secretName: string;
	lastSyncAt: string | null;
	lastError: string | null;
	liveTurfs: number;
}

/**
 * `new` is a campaign nobody has switched on yet — a secret was set and the
 * sync noticed it. `disabled` is one switched off after being on. The
 * difference matters to an admin: one is waiting to be set up, the other was
 * stopped on purpose.
 */
export function campaignChip(
	input: Pick<CampaignListInput, 'enabled' | 'disabledAt'>,
): CampaignChip {
	if (input.enabled) return 'enabled';
	return input.disabledAt ? 'disabled' : 'new';
}

export function campaignListRow(input: CampaignListInput): CampaignListRow {
	let health: CampaignHealth;
	let detail: string | null = null;
	if (input.credentialState === 'missing') {
		health = 'no-credentials';
		detail = `${input.secretName} is not set`;
	} else if (input.credentialState === 'invalid') {
		health = 'bad-credentials';
		detail = input.credentialError ?? `${input.secretName} could not be read`;
	} else if (input.lastError) {
		health = 'failing';
		detail = input.lastError;
	} else if (!input.lastSyncAt) {
		health = 'never';
	} else {
		health = 'ok';
	}
	return {
		id: input.id,
		name: input.name,
		chip: campaignChip(input),
		health,
		detail,
		lastSyncAt: input.lastSyncAt,
		liveTurfs: input.liveTurfs,
	};
}

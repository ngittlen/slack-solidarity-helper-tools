import { describe, it, expect } from 'vitest';
import {
	campaignSecretName,
	parseCampaignSecret,
	parseVanCampaigns,
} from './campaign-credentials.js';

const secret = (fields: Record<string, unknown>) => JSON.stringify(fields);
const valid = (apiKey = 'key-guid', databaseMode: unknown = 0) =>
	secret({ appName: 'campaign-app', apiKey, databaseMode });

describe('parseVanCampaigns', () => {
	it('reads one campaign per VAN_CAMPAIGN_<KEY> secret, keyed by the lowercased suffix', () => {
		const { credentials, errors, warnings } = parseVanCampaigns({
			VAN_CAMPAIGN_OTHER: valid('key-a', 0),
			VAN_CAMPAIGN_MI_2026: valid('key-b', 1),
			UNRELATED: 'x',
		});
		expect([...credentials.keys()].sort()).toEqual(['mi_2026', 'other']);
		expect(credentials.get('other')).toEqual({
			key: 'other',
			appName: 'campaign-app',
			apiKey: 'key-a',
			databaseMode: 0,
		});
		expect(credentials.get('mi_2026')?.databaseMode).toBe(1);
		expect(errors.size).toBe(0);
		expect(warnings).toEqual([]);
	});

	// `fly secrets set` hands everything over as a string, and a hand-written
	// secret is as likely to quote the mode as not.
	it('accepts the database mode as a string', () => {
		const { credentials } = parseVanCampaigns({ VAN_CAMPAIGN_OTHER: valid('k', '1') });
		expect(credentials.get('other')?.databaseMode).toBe(1);
	});

	it('ignores fields it does not know, so the format can grow', () => {
		const { credentials, errors } = parseVanCampaigns({
			VAN_CAMPAIGN_OTHER: secret({ appName: 'a', apiKey: 'k', databaseMode: 0, note: 'x' }),
		});
		expect(credentials.has('other')).toBe(true);
		expect(errors.size).toBe(0);
	});

	// The whole point of one secret per campaign: a typo in one is that
	// campaign's problem, not everybody's.
	it.each([
		['not valid JSON', '{"appName":"a","apiKey":"k"', 'is not valid JSON'],
		['an array', '[]', 'must be a JSON object'],
		['a bare string', '"hello"', 'must be a JSON object'],
		['missing appName', secret({ apiKey: 'k', databaseMode: 0 }), 'has no appName'],
		['blank apiKey', secret({ appName: 'a', apiKey: '  ', databaseMode: 0 }), 'has no apiKey'],
		['missing databaseMode', secret({ appName: 'a', apiKey: 'k' }), 'databaseMode must be 0'],
		['databaseMode 2', valid('k', 2), 'databaseMode must be 0'],
	])('isolates a secret that is %s', (_label, raw, message) => {
		const { credentials, errors } = parseVanCampaigns({
			VAN_CAMPAIGN_BROKEN: raw,
			VAN_CAMPAIGN_FINE: valid(),
		});
		expect(credentials.has('fine')).toBe(true);
		expect(credentials.has('broken')).toBe(false);
		expect(errors.get('broken')).toContain('VAN_CAMPAIGN_BROKEN');
		expect(errors.get('broken')).toContain(message);
	});

	it.each([
		'VAN_CAMPAIGN_other',
		'VAN_CAMPAIGN_MI-2026',
		'VAN_CAMPAIGN_',
		`VAN_CAMPAIGN_${'X'.repeat(41)}`,
	])('reports a malformed secret name %s under the name, not as a campaign', (name) => {
		const { credentials, errors } = parseVanCampaigns({ [name]: valid() });
		expect(credentials.size).toBe(0);
		expect([...errors.keys()]).toEqual([name]);
		expect(errors.get(name)).toContain('uppercase letters, digits or underscores');
	});

	it('does not mistake VAN_CAMPAIGNS for a campaign', () => {
		const { credentials, errors } = parseVanCampaigns({ VAN_CAMPAIGNS: '[]' });
		expect(credentials.size).toBe(0);
		expect(errors.size).toBe(0);
	});

	it('never puts a secret value in an error or warning', () => {
		const apiKey = 'super-secret-key-1234';
		const { errors, warnings } = parseVanCampaigns({
			VAN_CAMPAIGN_A: `{"appName":"a","apiKey":"${apiKey}"`,
			VAN_CAMPAIGN_B: secret({ appName: 'a', apiKey, databaseMode: 7 }),
			VAN_CAMPAIGN_PRIMARY: valid(apiKey),
			VAN_APP_NAME: 'legacy-app',
			VAN_API_KEY: apiKey,
			VAN_DATABASE_MODE: '0',
		});
		const text = [...errors.values(), ...warnings].join('\n');
		expect(errors.size).toBe(2);
		expect(warnings.length).toBe(1);
		expect(text).not.toContain(apiKey);
	});

	describe('legacy VAN_APP_NAME/VAN_API_KEY/VAN_DATABASE_MODE', () => {
		it('stand in for the primary campaign', () => {
			const { credentials, errors } = parseVanCampaigns({
				VAN_APP_NAME: 'legacy-app',
				VAN_API_KEY: 'legacy-key',
				VAN_DATABASE_MODE: '1',
			});
			expect(credentials.get('primary')).toEqual({
				key: 'primary',
				appName: 'legacy-app',
				apiKey: 'legacy-key',
				databaseMode: 1,
			});
			expect(errors.size).toBe(0);
		});

		it('are nothing at all when none of them is set', () => {
			const { credentials, errors } = parseVanCampaigns({});
			expect(credentials.size).toBe(0);
			expect(errors.size).toBe(0);
		});

		// .env.example ships VAN_DATABASE_MODE=0 beside a blank key, so an install
		// that never set VAN up looks exactly like this.
		it('are nothing at all when only the mode is set', () => {
			const { credentials, errors } = parseVanCampaigns({
				VAN_APP_NAME: '',
				VAN_API_KEY: '',
				VAN_DATABASE_MODE: '0',
			});
			expect(credentials.size).toBe(0);
			expect(errors.size).toBe(0);
		});

		it('report a half-set pair with the message the app has always given', () => {
			const { errors } = parseVanCampaigns({ VAN_APP_NAME: 'legacy-app', VAN_DATABASE_MODE: '0' });
			expect(errors.get('primary')).toBe('VAN_APP_NAME/VAN_API_KEY are not set');
		});

		// The wrong database mode authenticates successfully and returns a
		// different, near-empty database, so no value is assumed.
		it.each(['', '2', 'My Voters', ' '])('reject VAN_DATABASE_MODE %j', (mode) => {
			const { credentials, errors } = parseVanCampaigns({
				VAN_APP_NAME: 'legacy-app',
				VAN_API_KEY: 'legacy-key',
				VAN_DATABASE_MODE: mode,
			});
			expect(credentials.has('primary')).toBe(false);
			expect(errors.get('primary')).toContain('VAN_DATABASE_MODE');
		});

		it('give way to VAN_CAMPAIGN_PRIMARY, with a warning to unset them', () => {
			const { credentials, warnings } = parseVanCampaigns({
				VAN_CAMPAIGN_PRIMARY: valid('new-key', 1),
				VAN_APP_NAME: 'legacy-app',
				VAN_API_KEY: 'legacy-key',
				VAN_DATABASE_MODE: '0',
			});
			expect(credentials.get('primary')?.apiKey).toBe('new-key');
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('VAN_APP_NAME/VAN_API_KEY/VAN_DATABASE_MODE are ignored');
		});

		// A broken new secret must not quietly fall back to the old key: the
		// operator set it on purpose and needs to hear that it is wrong.
		it('do not rescue a malformed VAN_CAMPAIGN_PRIMARY', () => {
			const { credentials, errors } = parseVanCampaigns({
				VAN_CAMPAIGN_PRIMARY: 'not json',
				VAN_APP_NAME: 'legacy-app',
				VAN_API_KEY: 'legacy-key',
				VAN_DATABASE_MODE: '0',
			});
			expect(credentials.has('primary')).toBe(false);
			expect(errors.get('primary')).toContain('VAN_CAMPAIGN_PRIMARY is not valid JSON');
		});
	});
});

describe('parseCampaignSecret', () => {
	it('leaves the mode out when it is optional and absent, for van-check to probe', () => {
		const result = parseCampaignSecret('VAN_CAMPAIGN_X', secret({ appName: 'a', apiKey: 'k' }), {
			modeOptional: true,
		});
		expect(result).toEqual({ ok: true, appName: 'a', apiKey: 'k', databaseMode: null });
	});

	it('still rejects a bad mode when the mode is optional', () => {
		const result = parseCampaignSecret('VAN_CAMPAIGN_X', valid('k', 2), { modeOptional: true });
		expect(result.ok).toBe(false);
	});
});

describe('campaignSecretName', () => {
	it('is the inverse of the key', () => {
		expect(campaignSecretName('mi_2026')).toBe('VAN_CAMPAIGN_MI_2026');
	});
});

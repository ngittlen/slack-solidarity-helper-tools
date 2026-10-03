import { describe, it, expect } from 'vitest';
import { campaignChip, campaignListRow, type CampaignListInput } from './campaign-list.js';

const BASE: CampaignListInput = {
	id: 2,
	name: 'abdul',
	enabled: true,
	disabledAt: null,
	credentialState: 'ok',
	credentialError: null,
	secretName: 'VAN_CAMPAIGN_ABDUL',
	lastSyncAt: '2026-10-01T18:00:00.000Z',
	lastError: null,
	liveTurfs: 12,
};

describe('campaignChip', () => {
	it('tells a campaign never switched on from one switched off', () => {
		expect(campaignChip({ enabled: true, disabledAt: null })).toBe('enabled');
		expect(campaignChip({ enabled: false, disabledAt: null })).toBe('new');
		expect(campaignChip({ enabled: false, disabledAt: '2026-10-01T18:00:00.000Z' })).toBe(
			'disabled',
		);
	});
});

describe('campaignListRow', () => {
	it('reads ok for a campaign syncing cleanly', () => {
		expect(campaignListRow(BASE)).toEqual({
			id: 2,
			name: 'abdul',
			chip: 'enabled',
			health: 'ok',
			detail: null,
			lastSyncAt: '2026-10-01T18:00:00.000Z',
			liveTurfs: 12,
		});
	});

	it('reads never-synced before the first run', () => {
		expect(campaignListRow({ ...BASE, lastSyncAt: null }).health).toBe('never');
	});

	it('reads failing with the sync’s error', () => {
		const row = campaignListRow({ ...BASE, lastError: 'VAN /folders returned 500' });
		expect(row).toMatchObject({ health: 'failing', detail: 'VAN /folders returned 500' });
	});

	// Without usable credentials nothing else can be fixed first, so it wins
	// over a stale sync error.
	it('puts credential problems first, naming the secret', () => {
		expect(
			campaignListRow({ ...BASE, credentialState: 'missing', lastError: 'old error' }),
		).toMatchObject({ health: 'no-credentials', detail: 'VAN_CAMPAIGN_ABDUL is not set' });
		expect(
			campaignListRow({
				...BASE,
				credentialState: 'invalid',
				credentialError: 'VAN_CAMPAIGN_ABDUL is not valid JSON',
			}),
		).toMatchObject({ health: 'bad-credentials', detail: 'VAN_CAMPAIGN_ABDUL is not valid JSON' });
	});
});

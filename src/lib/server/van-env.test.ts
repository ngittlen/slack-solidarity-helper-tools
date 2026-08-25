import { describe, it, expect, beforeEach, vi } from 'vitest';
import { vanClient, isVanConfigured, vanExportJobTypeId } from './van-env.js';

const mockEnv = vi.hoisted(() => ({
	VAN_APP_NAME: 'campaign-app',
	VAN_API_KEY: 'key-guid',
	VAN_DATABASE_MODE: '0',
	VAN_EXPORT_JOB_TYPE_ID: 8,
}));

vi.mock('./env.js', () => ({
	get VAN_APP_NAME() {
		return mockEnv.VAN_APP_NAME;
	},
	get VAN_API_KEY() {
		return mockEnv.VAN_API_KEY;
	},
	get VAN_DATABASE_MODE() {
		return mockEnv.VAN_DATABASE_MODE;
	},
	get VAN_EXPORT_JOB_TYPE_ID() {
		return mockEnv.VAN_EXPORT_JOB_TYPE_ID;
	},
}));

describe('vanClient', () => {
	beforeEach(() => {
		mockEnv.VAN_APP_NAME = 'campaign-app';
		mockEnv.VAN_API_KEY = 'key-guid';
		mockEnv.VAN_DATABASE_MODE = '0';
		mockEnv.VAN_EXPORT_JOB_TYPE_ID = 8;
	});

	it('builds a client when fully configured', () => {
		const result = vanClient();
		expect(result.ok).toBe(true);
		expect(isVanConfigured()).toBe(true);
	});

	it('accepts My Campaign mode', () => {
		mockEnv.VAN_DATABASE_MODE = '1';
		expect(vanClient().ok).toBe(true);
	});

	it.each([
		['VAN_APP_NAME', 'VAN_APP_NAME' as const],
		['VAN_API_KEY', 'VAN_API_KEY' as const],
	])('reports %s missing rather than throwing', (_label, key) => {
		mockEnv[key] = '';
		const result = vanClient();
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain('VAN_APP_NAME/VAN_API_KEY');
		expect(isVanConfigured()).toBe(false);
	});

	// The wrong database mode authenticates successfully and returns a
	// different, near-empty database — a failure that reads as "the campaign
	// has no turf". Defaulting to 0 would hide it, so an unset value is an
	// error rather than an assumption.
	it.each(['', '2', 'My Voters', ' '])('rejects VAN_DATABASE_MODE %j', (mode) => {
		mockEnv.VAN_DATABASE_MODE = mode;
		const result = vanClient();
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain('VAN_DATABASE_MODE');
	});
});

describe('vanExportJobTypeId', () => {
	it('returns the configured id', () => {
		mockEnv.VAN_EXPORT_JOB_TYPE_ID = 8;
		expect(vanExportJobTypeId()).toBe(8);
	});

	it('returns null when unset, so the catalog sync still runs', () => {
		mockEnv.VAN_EXPORT_JOB_TYPE_ID = 0;
		expect(vanExportJobTypeId()).toBeNull();
	});

	it('returns null for an unparseable value', () => {
		mockEnv.VAN_EXPORT_JOB_TYPE_ID = NaN;
		expect(vanExportJobTypeId()).toBeNull();
	});
});

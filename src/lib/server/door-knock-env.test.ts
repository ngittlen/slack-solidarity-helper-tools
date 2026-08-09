import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	doorKnockProvider,
	isDoorKnockConfigured,
	doorKnockCanvasWatcher,
} from './door-knock-env.js';

const mockEnv = vi.hoisted(() => ({
	SLACK_BOT_TOKEN: 'xoxb-test',
	DOOR_KNOCK_PROVIDER: '',
	OPENFIELD_BASE_URL: 'https://campaign.openfield.ai',
	OPENFIELD_USERNAME: 'bot',
	OPENFIELD_PASSWORD: 'pw',
	DOOR_KNOCK_CHANNEL_ID: 'C_DOOR',
}));
const mockCreateWatcher = vi.hoisted(() => vi.fn(() => ({ handleFileChange: vi.fn() })));

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('./db.js', () => ({ db: {} }));
vi.mock('./door-knock/openfield/canvas-watch.js', () => ({
	createCanvasWatcher: mockCreateWatcher,
}));
vi.mock('./env.js', () => ({
	get SLACK_BOT_TOKEN() {
		return mockEnv.SLACK_BOT_TOKEN;
	},
	get DOOR_KNOCK_PROVIDER() {
		return mockEnv.DOOR_KNOCK_PROVIDER;
	},
	get OPENFIELD_BASE_URL() {
		return mockEnv.OPENFIELD_BASE_URL;
	},
	get OPENFIELD_USERNAME() {
		return mockEnv.OPENFIELD_USERNAME;
	},
	get OPENFIELD_PASSWORD() {
		return mockEnv.OPENFIELD_PASSWORD;
	},
	get DOOR_KNOCK_CHANNEL_ID() {
		return mockEnv.DOOR_KNOCK_CHANNEL_ID;
	},
}));

describe('doorKnockProvider', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockEnv.DOOR_KNOCK_PROVIDER = '';
		mockEnv.OPENFIELD_BASE_URL = 'https://campaign.openfield.ai';
		mockEnv.OPENFIELD_USERNAME = 'bot';
		mockEnv.OPENFIELD_PASSWORD = 'pw';
		mockEnv.DOOR_KNOCK_CHANNEL_ID = 'C_DOOR';
	});

	// Deployments predate the variable, so an unset one must keep working.
	it('defaults to Openfield when DOOR_KNOCK_PROVIDER is unset', () => {
		const result = doorKnockProvider();
		expect(result.ok).toBe(true);
		expect(result.ok && result.provider.name).toBe('openfield');
	});

	it('selects the named provider', () => {
		mockEnv.DOOR_KNOCK_PROVIDER = 'openfield';
		expect(doorKnockProvider().ok).toBe(true);
	});

	// A typo must not silently fall back to a provider that then writes rows
	// from the wrong tool.
	it('refuses an unknown provider name rather than falling back', () => {
		mockEnv.DOOR_KNOCK_PROVIDER = 'minivan';
		const result = doorKnockProvider();
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toMatch(/unknown DOOR_KNOCK_PROVIDER "minivan"/);
	});

	it('reports missing Openfield credentials', () => {
		mockEnv.OPENFIELD_BASE_URL = '';
		const result = doorKnockProvider();
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toMatch(/OPENFIELD/);
	});

	it('reports a missing door-knock channel', () => {
		mockEnv.DOOR_KNOCK_CHANNEL_ID = '';
		const result = doorKnockProvider();
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toMatch(/DOOR_KNOCK_CHANNEL_ID/);
	});

	it('isDoorKnockConfigured tracks whether a provider could be built', () => {
		expect(isDoorKnockConfigured()).toBe(true);
		mockEnv.OPENFIELD_PASSWORD = '';
		expect(isDoorKnockConfigured()).toBe(false);
	});
});

describe('doorKnockCanvasWatcher', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockEnv.DOOR_KNOCK_PROVIDER = '';
		mockEnv.OPENFIELD_BASE_URL = 'https://campaign.openfield.ai';
		mockEnv.OPENFIELD_USERNAME = 'bot';
		mockEnv.OPENFIELD_PASSWORD = 'pw';
		mockEnv.DOOR_KNOCK_CHANNEL_ID = 'C_DOOR';
	});

	it('builds a watcher for the Openfield provider', () => {
		expect(doorKnockCanvasWatcher()).not.toBeNull();
		expect(mockCreateWatcher).toHaveBeenCalledTimes(1);
	});

	it('returns null when Openfield is not fully configured', () => {
		mockEnv.DOOR_KNOCK_CHANNEL_ID = '';
		expect(doorKnockCanvasWatcher()).toBeNull();
		expect(mockCreateWatcher).not.toHaveBeenCalled();
	});

	// The canvas watcher exists only because Openfield's codes live on a
	// hand-edited Slack canvas — another provider gets no watcher at all rather
	// than a no-op one, so the Slack events route skips the work entirely.
	it('returns null for any other provider', () => {
		mockEnv.DOOR_KNOCK_PROVIDER = 'minivan';
		expect(doorKnockCanvasWatcher()).toBeNull();
		expect(mockCreateWatcher).not.toHaveBeenCalled();
	});
});

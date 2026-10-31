import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// env.ts reads its variables once, at import, so each case imports a fresh
// copy against its own environment.
const vars = vi.hoisted(() => ({ env: {} as Record<string, string> }));
vi.mock('$env/dynamic/private', () => ({
	get env() {
		return vars.env;
	},
}));

const GOOD_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
	.privateKey.export({ type: 'pkcs8', format: 'pem' })
	.toString();

const COMPLETE = {
	APPLE_SIGNIN_SERVICES_ID: 'org.example.turfs',
	APPLE_SIGNIN_TEAM_ID: 'TEAM123456',
	APPLE_SIGNIN_KEY_ID: 'KEY1234567',
	APPLE_SIGNIN_PRIVATE_KEY: GOOD_KEY,
};

async function configuredWith(env: Record<string, string>) {
	vars.env = env;
	vi.resetModules();
	return (await import('./env.js')).appleSignInConfigured;
}

describe('appleSignInConfigured', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('is on with all four set and a key that can sign', async () => {
		expect((await configuredWith(COMPLETE))()).toBe(true);
		expect(console.error).not.toHaveBeenCalled();
	});

	it.each(Object.keys(COMPLETE))('is off, silently, with %s unset', async (missing) => {
		const env = { ...COMPLETE } as Record<string, string>;
		delete env[missing];
		expect((await configuredWith(env))()).toBe(false);
		expect(console.error).not.toHaveBeenCalled();
	});

	it('accepts the key pasted on one line with literal \\n escapes', async () => {
		const oneLine = GOOD_KEY.trim().replace(/\n/g, '\\n');
		expect((await configuredWith({ ...COMPLETE, APPLE_SIGNIN_PRIVATE_KEY: oneLine }))()).toBe(true);
	});

	// A mangled paste: hidden, and said once — not on every page view.
	it('is off with a key that cannot sign, and logs it once without the key', async () => {
		const configured = await configuredWith({
			...COMPLETE,
			APPLE_SIGNIN_PRIVATE_KEY: 'not-a-key-SECRETBITS',
		});
		expect(configured()).toBe(false);
		expect(configured()).toBe(false);
		expect(console.error).toHaveBeenCalledTimes(1);
		expect(String(vi.mocked(console.error).mock.calls[0]![0])).not.toContain('SECRETBITS');
	});
});

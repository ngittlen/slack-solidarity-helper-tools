import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { applePrivateKeyProblem } from './env.js';

const pem = (key: ReturnType<typeof generateKeyPairSync>['privateKey']) =>
	key.export({ type: 'pkcs8', format: 'pem' }) as string;

describe('applePrivateKeyProblem', () => {
	it('accepts a P-256 EC key, as in Apple’s .p8', () => {
		const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
		expect(applePrivateKeyProblem(pem(privateKey))).toBeNull();
	});

	it('refuses a key that cannot sign ES256', () => {
		const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
		expect(applePrivateKeyProblem(pem(privateKey))).toMatch(/P-256/);
	});

	it('refuses a mangled paste, without echoing it', () => {
		const problem = applePrivateKeyProblem('-----BEGIN PRIVATE KEY----- MIGTAgEAMBMG secret');
		expect(problem).toMatch(/does not parse/);
		expect(problem).not.toContain('secret');
	});
});

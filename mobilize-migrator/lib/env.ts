// Loads secrets for the migrator scripts. Reads process.env first, then falls
// back to parsing the repo's .env.local (same file Vite loads in dev) so the
// standalone scripts work without exporting anything by hand.
//
// Values are never logged — callers pass them straight into Authorization /
// Cookie headers.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let fileVars: Record<string, string> | null = null;

function loadEnvFile(): Record<string, string> {
	if (fileVars) return fileVars;
	fileVars = {};
	for (const name of ['.env.local', '.env']) {
		let raw: string;
		try {
			raw = readFileSync(resolve(repoRoot, name), 'utf8');
		} catch {
			continue;
		}
		for (const line of raw.split('\n')) {
			const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
			if (!match) continue;
			const [, key, rawValue] = match;
			if (key in fileVars) continue; // .env.local wins over .env
			let value = rawValue.trim();
			if (
				(value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
				(value.startsWith("'") && value.endsWith("'") && value.length > 1)
			) {
				value = value.slice(1, -1);
			}
			fileVars[key] = value;
		}
	}
	return fileVars;
}

export function env(key: string): string {
	return process.env[key] ?? loadEnvFile()[key] ?? '';
}

export function requireEnv(key: string, hint: string): string {
	const value = env(key);
	if (!value) {
		throw new Error(`Missing ${key} — ${hint}`);
	}
	return value;
}

// Shared Turso connection config for non-SvelteKit entry points (drizzle.config,
// the migrate runner, the one-off baseline script). The SvelteKit app reads the
// same vars via $env/dynamic/private in src/lib/server/env.ts — that path can't
// be reused here because $env/* only exists inside the Vite-built bundle.

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
	throw new Error(
		'TURSO_DATABASE_URL is not set. For drizzle-kit, did you forget --env-file=.env.local?',
	);
}

const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url.startsWith('file:') && !authToken) {
	throw new Error(`TURSO_AUTH_TOKEN is required for non-file URLs (got ${url}).`);
}

export const dbConfig = { url, authToken };

// The site name, read once and cached.
//
// Sits alongside server/theme.ts and for the same reason: this is read on every
// page render to build the document title, so it must not be a fresh
// seven-table loadSettings() call each time. One narrow column, cached in
// module scope, invalidated when app_config is written.
//
// Same per-process caveat as the theme cache: with more than one Fly machine an
// edit reaches the others when their TTL lapses, which is fine for a name.

import { dev } from '$app/environment';
import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';

import { appConfig } from './schema.js';
import { resolveSiteName } from '$lib/site-name.js';

type Database = ReturnType<typeof drizzle>;

/** Zero in dev so editing the setting shows up on the next reload. */
const TTL_MS = dev ? 0 : 5 * 60 * 1000;

let cache: { name: string; fetchedAt: number } | null = null;

export function invalidateSiteNameCache(): void {
	cache = null;
}

export async function getSiteName(db: Database): Promise<string> {
	if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.name;
	try {
		const rows = await db
			.select({ siteName: appConfig.siteName })
			.from(appConfig)
			.where(eq(appConfig.id, 1))
			.limit(1);
		cache = { name: resolveSiteName(rows[0]?.siteName), fetchedAt: Date.now() };
	} catch (err) {
		// A title is not worth failing a page over. Serve the default and retry
		// next request rather than caching the failure.
		console.error('[site] could not read site name, using the default:', err);
		return resolveSiteName(null);
	}
	return cache.name;
}

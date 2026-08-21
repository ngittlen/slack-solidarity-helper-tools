// Reading the stored theme and turning it into the stylesheet the page ships.
//
// This runs on EVERY page render, so it is cached in module scope and
// invalidated on save rather than hitting the database each time. The cache is
// per-process: with more than one Fly machine, an edit made on one is picked up
// by the others when their TTL lapses. That is the right trade for a settings
// change — a minute of staleness on a colour is invisible, and the alternative
// is a DB round-trip on every request for data that changes a few times a year.

import { dev } from '$app/environment';
import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';

import { appConfig } from './schema.js';
import {
	parseOverrides,
	resolveTheme,
	themeCss,
	type ResolvedTheme,
} from '$lib/styles/theme-css.js';

type Database = ReturnType<typeof drizzle>;

/** Long in production, because a save invalidates explicitly — this only bounds
 *  how stale a *sibling process* can be.
 *
 *  Zero in dev: otherwise editing tokens.ts appears to do nothing for five
 *  minutes, because the cached CSS string outlives the module reload. That cost
 *  me a debugging session; it should not cost anyone else one. */
const TTL_MS = dev ? 0 : 5 * 60 * 1000;

interface CacheEntry {
	css: string;
	theme: ResolvedTheme;
	fetchedAt: number;
}

let cache: CacheEntry | null = null;

/** Called by the save path so an admin sees their change on the next render
 *  rather than waiting out the TTL. */
export function invalidateThemeCache(): void {
	cache = null;
}

/** Raw stored overrides as JSON text, for the settings editor to seed from.
 *  Returns '{}' when unset. */
export async function loadThemeTokensJson(db: Database): Promise<string> {
	const rows = await db
		.select({ themeTokens: appConfig.themeTokens })
		.from(appConfig)
		.where(eq(appConfig.id, 1))
		.limit(1);
	return rows[0]?.themeTokens ?? '{}';
}

async function read(db: Database): Promise<CacheEntry> {
	let raw: unknown;
	try {
		raw = JSON.parse(await loadThemeTokensJson(db));
	} catch (err) {
		// A malformed blob must not take the site's styling down. Fall through
		// with no overrides — the brand defaults are always valid.
		console.error('[theme] stored theme_tokens is not usable, falling back to defaults:', err);
		raw = null;
	}

	const { config, rejected } = parseOverrides(raw);
	if (rejected.length > 0) {
		console.warn(`[theme] ignored ${rejected.length} invalid token(s): ${rejected.join(', ')}`);
	}

	const theme = resolveTheme(config);
	return { css: themeCss(theme), theme, fetchedAt: Date.now() };
}

/** The resolved theme plus its stylesheet. Cached. */
export async function getTheme(db: Database): Promise<CacheEntry> {
	if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
	try {
		cache = await read(db);
	} catch (err) {
		// Database down. Serve brand defaults rather than an unstyled page —
		// a themeless app is a broken-looking app, and this is only cosmetic
		// data. Not cached, so it retries next request.
		console.error('[theme] could not read theme, serving defaults:', err);
		const theme = resolveTheme();
		return { css: themeCss(theme), theme, fetchedAt: 0 };
	}
	return cache;
}

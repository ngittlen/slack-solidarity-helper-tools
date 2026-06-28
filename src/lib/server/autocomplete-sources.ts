// Live-list fetchers for the settings-page pickers (NAV-3) and the save-time
// validators (settings-validation.ts). Each fetcher is fronted by a 5-minute
// module-state cache with in-flight de-duplication and a stale-serve fallback
// when a refetch fails. No DB, no HTTP route, no UI.
//
// Failure model is intentionally narrow: a fetcher returns
// `{ items, stale }` on success or stale-serve, and **rejects only** when the
// cache is cold and the fetch failed (FR-011). That lets the NAV-3 loader use
// `Promise.allSettled` to degrade one section while keeping the others.

import type { WebClient } from '@slack/web-api';
import { fetchPaginated } from './solidarity-paginate.js';

// ---------------------------------------------------------------------------
// Exported value types
// ---------------------------------------------------------------------------

export interface ChannelEntry {
	id: string;
	name: string;
	isPrivate: boolean;
}

export interface UserEntry {
	id: string;
	/** Display name — profile.display_name || profile.real_name || name. */
	name: string;
	/** profile.real_name; may be empty. */
	realName: string;
}

export interface SolidarityChapterEntry {
	id: number;
	name: string;
}

export interface AutocompleteResult<T> {
	/** Sorted ascending by display name. */
	items: T[];
	/** `true` when the items came from a retained cache after a refetch failed. */
	stale: boolean;
	/**
	 * Unix ms when the items in this result were originally fetched successfully.
	 * On a stale-serve (`stale: true`), this reflects the original successful
	 * fetch's timestamp, NOT the failed refetch attempt — so the NAV-3 settings
	 * page's "Last refreshed Nm ago" indicator reports how old the data the
	 * admin is picking against actually is.
	 */
	fetchedAt: number;
}

export interface AutocompleteOptions {
	/** Bypass the freshness check and refetch (the "Refresh lists" path). */
	force?: boolean;
}

// ---------------------------------------------------------------------------
// Cache state (module-private)
// ---------------------------------------------------------------------------

const TTL_MS = 5 * 60 * 1000;

// `credential` is whatever identifies "who fetched this data" — the WebClient
// instance for Slack, the token string for Solidarity. If a request comes in
// with a different credential, the cached data is treated as belonging to a
// different tenant and is not served. Defensive; spec is single-tenant today.
interface CacheEntry<T, C> {
	data: T[] | null;
	fetchedAt: number;
	credential: C | null;
	// In-flight non-forced fetch, deduplicated across concurrent callers.
	// Forced fetches never use this slot — they always run their own request
	// so a forced caller can't piggy-back on a possibly-failing refetch and
	// receive a stale-flagged result (FR-009).
	inFlight: { promise: Promise<AutocompleteResult<T>>; credential: C } | null;
}

function makeEntry<T, C>(): CacheEntry<T, C> {
	return { data: null, fetchedAt: 0, credential: null, inFlight: null };
}

const channelsEntry: CacheEntry<ChannelEntry, WebClient> = makeEntry();
const usersEntry: CacheEntry<UserEntry, WebClient> = makeEntry();
const chaptersEntry: CacheEntry<SolidarityChapterEntry, string> = makeEntry();

/**
 * Test-only: drop all cached lists and in-flight state so each test starts
 * from a cold cache without needing `vi.resetModules()` gymnastics. Mirrors
 * the `_resetSlackEmailCache` pattern in `src/routes/api/pending/+server.ts`.
 */
export function _resetAutocompleteCachesForTests(): void {
	Object.assign(channelsEntry, makeEntry<ChannelEntry, WebClient>());
	Object.assign(usersEntry, makeEntry<UserEntry, WebClient>());
	Object.assign(chaptersEntry, makeEntry<SolidarityChapterEntry, string>());
}

/**
 * Run one fetch, update the cache on success, or fall back to retained stale
 * data on failure (FR-010 / FR-010a). Stale data is only returned when it was
 * fetched with the *same* credential — never serve a previous tenant's data
 * after a credential change.
 */
async function runFetch<T, C>(
	entry: CacheEntry<T, C>,
	listName: string,
	credential: C,
	fetcher: () => Promise<T[]>,
): Promise<AutocompleteResult<T>> {
	try {
		const result = await fetcher();
		entry.data = result;
		entry.fetchedAt = Date.now();
		entry.credential = credential;
		return { items: result, stale: false, fetchedAt: entry.fetchedAt };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (entry.data !== null && entry.credential === credential) {
			console.warn(`[autocomplete] ${listName} refetch failed; serving stale: ${msg}`);
			// `fetchedAt` deliberately reflects the original successful fetch,
			// not the failed refetch attempt (NAV-3 R2).
			return { items: entry.data, stale: true, fetchedAt: entry.fetchedAt };
		}
		console.error(`[autocomplete] ${listName} fetch failed (no cached data): ${msg}`);
		throw err;
	}
}

/**
 * Shared cache state machine — TTL freshness, force bypass, in-flight de-dup,
 * and credential binding (FR-007 / FR-007a / FR-008 / FR-009 / FR-010 /
 * FR-010a / FR-011).
 */
async function getCached<T, C>(
	entry: CacheEntry<T, C>,
	listName: string,
	credential: C,
	fetcher: () => Promise<T[]>,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<T>> {
	const now = Date.now();
	const credentialMatch = entry.credential === credential;
	const fresh = credentialMatch && entry.data !== null && now - entry.fetchedAt < TTL_MS;

	if (!opts.force && fresh) {
		// Non-null assertion safe — `fresh` implies `entry.data !== null`.
		return { items: entry.data as T[], stale: false, fetchedAt: entry.fetchedAt };
	}

	// Forced refresh never piggy-backs on an in-flight non-forced fetch — the
	// admin clicked "Refresh lists" precisely to escape a possibly-stale result.
	// Concurrent forced calls each issue their own upstream request (rare).
	if (opts.force) {
		return runFetch(entry, listName, credential, fetcher);
	}

	// Reuse the in-flight only if it was started with the same credential.
	if (entry.inFlight && entry.inFlight.credential === credential) {
		return entry.inFlight.promise;
	}

	const promise = runFetch(entry, listName, credential, fetcher);
	entry.inFlight = { promise, credential };
	// `.then(cleanup, cleanup)` rather than `.finally` so the cleanup branch
	// doesn't surface an unhandled rejection when the original promise rejects.
	const cleanup = () => {
		if (entry.inFlight?.promise === promise) entry.inFlight = null;
	};
	promise.then(cleanup, cleanup);
	return promise;
}

// ---------------------------------------------------------------------------
// Public fetchers
// ---------------------------------------------------------------------------

function byName<T extends { name: string }>(a: T, b: T): number {
	return a.name.localeCompare(b.name);
}

export function getSlackChannels(
	slack: WebClient,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<ChannelEntry>> {
	return getCached(channelsEntry, 'channels', slack, async () => {
		const items: ChannelEntry[] = [];
		let cursor: string | undefined;
		do {
			const page = await slack.conversations.list({
				types: 'public_channel,private_channel',
				exclude_archived: true,
				limit: 1000,
				cursor,
			});
			for (const ch of page.channels ?? []) {
				if (ch.id && ch.name) {
					items.push({ id: ch.id, name: ch.name, isPrivate: ch.is_private === true });
				}
			}
			cursor = page.response_metadata?.next_cursor || undefined;
		} while (cursor);
		items.sort(byName);
		return items;
	}, opts);
}

export function getSlackUsers(
	slack: WebClient,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<UserEntry>> {
	return getCached(usersEntry, 'users', slack, async () => {
		const items: UserEntry[] = [];
		let cursor: string | undefined;
		do {
			const page = await slack.users.list({ limit: 1000, cursor });
			for (const m of page.members ?? []) {
				if (m.is_bot || m.deleted) continue;
				if (!m.id) continue;
				const profile = m.profile;
				const display =
					profile?.display_name?.trim() ||
					profile?.real_name?.trim() ||
					m.name?.trim() ||
					m.id;
				items.push({
					id: m.id,
					name: display,
					realName: profile?.real_name ?? '',
				});
			}
			cursor = page.response_metadata?.next_cursor || undefined;
		} while (cursor);
		items.sort(byName);
		return items;
	}, opts);
}

export function getSolidarityChapters(
	token: string,
	opts: AutocompleteOptions = {},
): Promise<AutocompleteResult<SolidarityChapterEntry>> {
	return getCached(chaptersEntry, 'chapters', token, async () => {
		const raw = await fetchPaginated<{ id: number; name: string }>(
			token,
			'/v1/chapters',
			'/v1/chapters',
			'',
			'autocomplete',
		);
		const items: SolidarityChapterEntry[] = raw.map((c) => ({ id: c.id, name: c.name }));
		items.sort(byName);
		return items;
	}, opts);
}
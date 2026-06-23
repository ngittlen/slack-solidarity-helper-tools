import { redirect, error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

import { db } from '$lib/server/db.js';
import { slack } from '$lib/server/slack.js';
import { SOLIDARITY_API_TOKEN } from '$lib/server/env.js';
import { loadSettings, type Settings } from '$lib/server/settings.js';
import {
	getSlackChannels,
	getSlackUsers,
	getSolidarityChapters,
	type AutocompleteResult,
	type ChannelEntry,
	type UserEntry,
	type SolidarityChapterEntry,
} from '$lib/server/autocomplete-sources.js';

// The page shell renders five empty <section>s; per-source error markers feed
// inline notices in the sections that depend on the failing source;
// oldestFetchedAt drives the "Last refreshed Nm ago" indicator.
export interface SettingsPageData {
	pageTitle: 'Settings';
	settings: Settings;
	slackChannels: AutocompleteResult<ChannelEntry> | null;
	slackUsers: AutocompleteResult<UserEntry> | null;
	solidarityChapters: AutocompleteResult<SolidarityChapterEntry> | null;
	errors: {
		slackChannels?: string;
		slackUsers?: string;
		solidarityChapters?: string;
	};
	oldestFetchedAt: number | null;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export const load: PageServerLoad = async ({ locals, url }) => {
	// Admin gate. Non-admin authenticated users and missing-session callers
	// alike land on `/`, matching the bare-302 pattern in routes/pending and
	// Constitution Principle I's defensive default.
	if (!locals.session?.isAdmin) {
		redirect(302, '/');
	}

	// `?refresh=lists` is the "Refresh lists" affordance's escape hatch from
	// the 5-minute autocomplete TTL. Any other value of `refresh` is
	// ignored — defensive against bookmarks / link previews.
	const force = url.searchParams.get('refresh') === 'lists';

	// All four sources run in parallel via Promise.allSettled so any one
	// rejection degrades just its source rather than blowing up the page —
	// except loadSettings, which is page-fatal (see below).
	const [settingsResult, channelsResult, usersResult, chaptersResult] =
		await Promise.allSettled([
			loadSettings(db),
			getSlackChannels(slack, { force }),
			getSlackUsers(slack, { force }),
			getSolidarityChapters(SOLIDARITY_API_TOKEN, { force }),
		]);

	if (settingsResult.status === 'rejected') {
		console.error('[settings] loadSettings failed', settingsResult.reason);
		error(500, 'Failed to load settings');
	}

	const errors: SettingsPageData['errors'] = {};
	const slackChannels =
		channelsResult.status === 'fulfilled' ? channelsResult.value : null;
	if (channelsResult.status === 'rejected') {
		errors.slackChannels = errMessage(channelsResult.reason);
	}
	const slackUsers =
		usersResult.status === 'fulfilled' ? usersResult.value : null;
	if (usersResult.status === 'rejected') {
		errors.slackUsers = errMessage(usersResult.reason);
	}
	const solidarityChapters =
		chaptersResult.status === 'fulfilled' ? chaptersResult.value : null;
	if (chaptersResult.status === 'rejected') {
		errors.solidarityChapters = errMessage(chaptersResult.reason);
	}

	// "Oldest of three" reduction for the "Last refreshed Nm ago" indicator.
	// Null when every list rejected — the indicator renders an em-dash.
	const fetchedAts = [slackChannels, slackUsers, solidarityChapters]
		.filter((r): r is NonNullable<typeof r> => r !== null)
		.map((r) => r.fetchedAt);
	const oldestFetchedAt = fetchedAts.length === 0 ? null : Math.min(...fetchedAts);

	return {
		pageTitle: 'Settings' as const,
		settings: settingsResult.value,
		slackChannels,
		slackUsers,
		solidarityChapters,
		errors,
		oldestFetchedAt,
	} satisfies SettingsPageData;
};

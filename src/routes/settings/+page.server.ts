import { redirect, error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

import { errMessage } from '$lib/err-message.js';
import { db } from '$lib/server/db.js';
import { credentialStatus, ensureCampaignRows } from '$lib/server/van-env.js';
import { campaignName } from '$lib/server/van/campaigns.js';
import { loadCampaignSummaries } from '$lib/server/van/campaign-status-store.js';
import { campaignListRow, type CampaignListRow } from '$lib/van/campaign-list.js';
import { slack } from '$lib/server/slack.js';
import {
	appleSignInConfigured,
	googleSignInConfigured,
	SOLIDARITY_API_TOKEN,
} from '$lib/server/env.js';
import {
	loadSettings,
	refreshChapterNames,
	type ChapterRename,
	loadVanBlockedUsers,
	type Settings,
	type VanBlockedUserEntry,
} from '$lib/server/settings.js';
import { loadThemeTokensJson } from '$lib/server/theme.js';
import {
	countOutsideVolunteers,
	loadBlockableOutsideVolunteers,
	type BlockableOutsideVolunteer,
} from '$lib/server/outside-volunteers.js';
import { loadDoorsTicker, type TickerEntry } from '$lib/server/van/doors-store.js';
import {
	computeWeeklyLeaderboard,
	computeLiveLeaderboardSinceSnapshot,
	firstChannelByChapter,
	type WeeklyLeaderboard,
	type LeaderboardResult,
	type LeaderboardPair,
} from '$lib/server/weekly-growth-report.js';
import {
	getSlackChannels,
	getSlackUsers,
	getSolidarityChapters,
	getSolidarityCustomProperties,
	getSolidarityUserLists,
	type AutocompleteResult,
	type ChannelEntry,
	type UserEntry,
	type SolidarityChapterEntry,
	type CustomPropertyEntry,
	type UserListEntry,
} from '$lib/server/autocomplete-sources.js';

// The page shell renders five empty <section>s; per-source error markers feed
// inline notices in the sections that depend on the failing source;
// oldestFetchedAt drives the "Last refreshed Nm ago" indicator.
export interface SettingsPageData {
	pageTitle: 'Settings';
	/** The signed-in admin's own Slack id — the allowed-users editor locks
	 *  their chip so they can't attempt to remove themselves. */
	selfSlackUserId: string;
	settings: Settings;
	/** Stored chapter names this load brought up to date with Solidarity's —
	 *  shown once on the page, so a rename is visible rather than silent. */
	renamedChapters: ChapterRename[];
	/** Every VAN campaign, each linking to its own settings page — where its
	 *  folders, spreadsheets and switches are edited. */
	vanCampaigns: CampaignListRow[];
	vanBlockedUsers: VanBlockedUserEntry[];
	/** How many Google and Apple volunteers have a stored record, for the
	 *  end-of-campaign clear. Zeros when the read failed. */
	outsideVolunteerCounts: { google: number; apple: number };
	/** Who the block-list picker offers: everyone with a record plus any
	 *  Google or Apple volunteer holding turf without one. */
	outsideBlockable: BlockableOutsideVolunteer[];
	/** Whether Google or Apple sign-in is configured — the records section
	 *  shows when one is, or while any records remain from when one was. */
	outsideSignIn: boolean;
	/** Stored theme overrides as JSON; '{}' when untouched. */
	themeTokens: string;
	slackChannels: AutocompleteResult<ChannelEntry> | null;
	slackUsers: AutocompleteResult<UserEntry> | null;
	solidarityChapters: AutocompleteResult<SolidarityChapterEntry> | null;
	customProperties: AutocompleteResult<CustomPropertyEntry> | null;
	userLists: AutocompleteResult<UserListEntry> | null;
	errors: {
		slackChannels?: string;
		slackUsers?: string;
		solidarityChapters?: string;
		customProperties?: string;
		userLists?: string;
		vanCampaigns?: string;
		vanBlocklist?: string;
		outsideVolunteers?: string;
	};
	oldestFetchedAt: number | null;
	/** Today's real ticker standings, so the speed slider previews the board
	 *  the way the alpha slider previews the leaderboard. Empty before the
	 *  first canvasser snapshot — the editor falls back to sample names. */
	tickerEntries: TickerEntry[];
	/** Same saved/live pair the dashboard renders, but with UNTRIMMED
	 *  topChapters so the App-config alpha slider can re-rank the full list
	 *  client-side and show how the top 5 would change. */
	leaderboard: LeaderboardPair;
}

async function safeLeaderboard(
	label: string,
	compute: () => Promise<WeeklyLeaderboard>,
): Promise<LeaderboardResult> {
	try {
		return { ok: true, leaderboard: await compute() };
	} catch (err) {
		console.error(`[settings] ${label} leaderboard load failed:`, errMessage(err));
		return { ok: false, error: 'Failed to load leaderboard preview. Please try again.' };
	}
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

	// All six sources run in parallel via Promise.allSettled so any one
	// rejection degrades just its source rather than blowing up the page —
	// except loadSettings, which is page-fatal (see below).
	const [
		settingsResult,
		channelsResult,
		usersResult,
		chaptersResult,
		propertiesResult,
		listsResult,
	] = await Promise.allSettled([
		loadSettings(db),
		getSlackChannels(slack, { force }),
		getSlackUsers(slack, { force }),
		getSolidarityChapters(SOLIDARITY_API_TOKEN, { force }),
		getSolidarityCustomProperties(SOLIDARITY_API_TOKEN, { force }),
		getSolidarityUserLists(SOLIDARITY_API_TOKEN, { force }),
	]);

	if (settingsResult.status === 'rejected') {
		console.error('[settings] loadSettings failed', settingsResult.reason);
		error(500, 'Failed to load settings');
	}

	const errors: SettingsPageData['errors'] = {};
	const slackChannels = channelsResult.status === 'fulfilled' ? channelsResult.value : null;
	if (channelsResult.status === 'rejected') {
		errors.slackChannels = errMessage(channelsResult.reason);
	}
	const slackUsers = usersResult.status === 'fulfilled' ? usersResult.value : null;
	if (usersResult.status === 'rejected') {
		errors.slackUsers = errMessage(usersResult.reason);
	}
	const solidarityChapters = chaptersResult.status === 'fulfilled' ? chaptersResult.value : null;
	if (chaptersResult.status === 'rejected') {
		errors.solidarityChapters = errMessage(chaptersResult.reason);
	}
	const customProperties = propertiesResult.status === 'fulfilled' ? propertiesResult.value : null;
	if (propertiesResult.status === 'rejected') {
		errors.customProperties = errMessage(propertiesResult.reason);
	}
	const userLists = listsResult.status === 'fulfilled' ? listsResult.value : null;
	if (listsResult.status === 'rejected') {
		errors.userLists = errMessage(listsResult.reason);
	}

	// Leaderboard data for the alpha-slider preview — the dashboard's exact
	// saved/live computation, minus the top-5 trim. Runs after loadSettings
	// resolves because it needs the effective exclusions and channel map.
	let settings = settingsResult.value;

	// Chapter names stored with the channel map and the folder mapping go stale
	// when Solidarity renames a chapter, and /turfs lists them by the stored
	// name. This page has the live list, so it brings them up to date — and the
	// rest of this load uses the new names too. Never page-fatal.
	let renamedChapters: ChapterRename[] = [];
	if (solidarityChapters) {
		try {
			renamedChapters = await refreshChapterNames(db, solidarityChapters.items);
		} catch (err) {
			console.error('[settings] chapter name refresh failed:', errMessage(err));
		}
	}
	if (renamedChapters.length > 0) {
		const renamed = new Map(renamedChapters.map((r) => [r.chapterId, r.to]));
		settings = {
			...settings,
			chapterChannelMap: settings.chapterChannelMap.map((e) => ({
				...e,
				name: renamed.get(e.chapterId) ?? e.name,
			})),
		};
	}

	const leaderboardOpts = {
		excludedChapterIds: settings.reportExcludedChapterIds,
		chapterChannelIds: firstChannelByChapter(settings.chapterChannelMap),
		rankingAlpha: settings.slackGrowthReportRankingAlpha,
		topN: Number.POSITIVE_INFINITY,
	};
	const [saved, live] = await Promise.all([
		safeLeaderboard('saved', () => computeWeeklyLeaderboard(db, leaderboardOpts)),
		safeLeaderboard('live', () =>
			computeLiveLeaderboardSinceSnapshot(db, { ...leaderboardOpts, slack }),
		),
	]);
	const leaderboard: LeaderboardPair = { saved, live };

	// "Oldest of the live lists" reduction for the "Last refreshed Nm ago"
	// indicator. Null when every list rejected — the indicator renders an em-dash.
	const fetchedAts = [slackChannels, slackUsers, solidarityChapters, customProperties, userLists]
		.filter((r): r is NonNullable<typeof r> => r !== null)
		.map((r) => r.fetchedAt);
	const oldestFetchedAt = fetchedAts.length === 0 ? null : Math.min(...fetchedAts);

	// Best-effort: an empty ticker just means the preview uses sample names.
	let tickerEntries: TickerEntry[] = [];
	try {
		tickerEntries = (await loadDoorsTicker(db)).entries;
	} catch (err) {
		console.error('[settings] doors ticker load failed:', err instanceof Error ? err.message : err);
	}

	// VAN turf-checkout settings and the stored theme, in one parallel batch.
	// Loaded separately from loadSettings rather than folded into it: the blocked
	// set is read on every turf page load and the theme on every render, so both
	// stay narrow queries (see settings.ts and server/theme.ts). None is
	// page-fatal — an empty mapping just means no turf is published yet, and a
	// theme read failure means the editor opens on the brand defaults, which is
	// also what the site is rendering.
	// A campaign secret set since the last sync gets its (disabled) row now, so
	// it shows up the moment an admin looks rather than after the next sync
	// tick — or never, locally, where no scheduler runs. The same bookkeeping
	// the sync does: idempotent, and no VAN call.
	try {
		await ensureCampaignRows(db);
	} catch (err) {
		console.error('[settings] campaign discovery failed:', errMessage(err));
	}
	const [
		vanCampaignsResult,
		vanBlockedUsersResult,
		themeTokensResult,
		outsideCountsResult,
		outsideBlockableResult,
	] = await Promise.allSettled([
		loadCampaignSummaries(db),
		loadVanBlockedUsers(db),
		loadThemeTokensJson(db),
		countOutsideVolunteers(db),
		loadBlockableOutsideVolunteers(db),
	]);
	// Credentials are described, never shown: credentialStatus carries no key.
	const vanCampaigns =
		vanCampaignsResult.status === 'fulfilled'
			? vanCampaignsResult.value.map(({ campaign, liveTurfs, lastSyncAt, lastError }) => {
					const credentials = credentialStatus(campaign);
					return campaignListRow({
						id: campaign.id,
						name: campaignName(campaign),
						enabled: campaign.enabled,
						disabledAt: campaign.disabledAt,
						credentialState: credentials.state,
						credentialError: credentials.error,
						secretName: credentials.secretName,
						lastSyncAt,
						lastError,
						liveTurfs,
					});
				})
			: [];
	const vanBlockedUsers =
		vanBlockedUsersResult.status === 'fulfilled' ? vanBlockedUsersResult.value : [];
	const themeTokens = themeTokensResult.status === 'fulfilled' ? themeTokensResult.value : '{}';
	if (vanCampaignsResult.status === 'rejected') {
		errors.vanCampaigns = 'Failed to load the VAN campaigns.';
	}
	if (vanBlockedUsersResult.status === 'rejected') {
		errors.vanBlocklist = 'Failed to load the turf-checkout block list.';
	}
	// Only the count goes to the browser: the records section shows nothing
	// else, and the picker takes its names and emails from outsideBlockable.
	const outsideVolunteerCounts =
		outsideCountsResult.status === 'fulfilled'
			? outsideCountsResult.value
			: { google: 0, apple: 0 };
	const outsideBlockable =
		outsideBlockableResult.status === 'fulfilled' ? outsideBlockableResult.value : [];
	if (outsideCountsResult.status === 'rejected' || outsideBlockableResult.status === 'rejected') {
		errors.outsideVolunteers = 'Failed to load the Google and Apple volunteers.';
	}

	return {
		pageTitle: 'Settings' as const,
		selfSlackUserId: locals.session.slackUserId,
		settings,
		renamedChapters,
		vanCampaigns,
		vanBlockedUsers,
		outsideVolunteerCounts,
		outsideBlockable,
		outsideSignIn: googleSignInConfigured() || appleSignInConfigured(),
		themeTokens,
		leaderboard,
		slackChannels,
		slackUsers,
		solidarityChapters,
		customProperties,
		userLists,
		errors,
		oldestFetchedAt,
		tickerEntries,
	} satisfies SettingsPageData;
};

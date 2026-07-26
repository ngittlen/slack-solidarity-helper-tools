import { sqliteTable, text, integer, real, uniqueIndex, primaryKey, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const requests = sqliteTable('requests', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	email: text('email').unique(),
	name: text('name'),
	phone: text('phone'),
	comment: text('comment'),
	requestedAt: text('requested_at').notNull(),
	lastEditedById: text('last_edited_by_id'),
	lastEditedByName: text('last_edited_by_name'),
	status: text('status').notNull().default('uncontacted'),
});

export const sessions = sqliteTable('sessions', {
	sid: text('sid').primaryKey(),
	data: text('data').notNull(),
	expiresAt: text('expires_at').notNull(),
});

export const slackJoins = sqliteTable(
	'slack_joins',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		slackUserId: text('slack_user_id').notNull(),
		email: text('email'),
		joinedAt: text('joined_at'),
		chapterIds: text('chapter_ids').notNull().default('[]'),
	},
	(table) => [uniqueIndex('slack_joins_slack_user_id_unique').on(table.slackUserId)],
);

export const solidarityDailySnapshots = sqliteTable(
	'solidarity_daily_snapshots',
	{
		date: text('date').notNull(),
		chapterId: integer('chapter_id').notNull().default(-1),
		chapterName: text('chapter_name'),
		count: integer('count').notNull().default(0),
	},
	(table) => [primaryKey({ columns: [table.date, table.chapterId] })],
);

// Per-window leaderboard snapshot written by the Monday cron. Preserves the
// num_members count from conversations.info at compute time so the dashboard
// keeps showing a stable Mon-to-Mon leaderboard instead of drifting against a
// growing live num_members.
export const weeklyGrowthWindows = sqliteTable('weekly_growth_windows', {
	windowEnd: text('window_end').primaryKey(),
	windowStart: text('window_start').notNull(),
	totalNewJoins: integer('total_new_joins').notNull(),
	computedAt: text('computed_at').notNull(),
});

export const weeklyChapterGrowth = sqliteTable(
	'weekly_chapter_growth',
	{
		windowEnd: text('window_end').notNull(),
		chapterId: integer('chapter_id').notNull(),
		chapterName: text('chapter_name').notNull(),
		slackChannelId: text('slack_channel_id'),
		newJoins: integer('new_joins').notNull(),
		existing: integer('existing').notNull(),
		// Raw num_members reported by Slack at compute time, before subtracting
		// newJoins to derive `existing`. Kept for auditing.
		numMembers: integer('num_members'),
	},
	(table) => [primaryKey({ columns: [table.windowEnd, table.chapterId] })],
);

// Settings tables (NAV-1). Each table carries audit columns enforced .notNull()
// so writes can never lose attribution. The `app_config` singleton is enforced
// via the natural PK collision plus a redundant CHECK (id = 1) for defense in
// depth and to document intent in the generated migration SQL.

// Composite (chapter_id, channel_id) key: a chapter may map to any number of
// Slack channels, and new joiners are invited to every mapped channel.
export const chapterChannelMap = sqliteTable(
	'chapter_channel_map',
	{
		chapterId: integer('chapter_id').notNull(),
		channelId: text('channel_id').notNull(),
		name: text('name').notNull(),
		lastEditedBy: text('last_edited_by').notNull(),
		lastEditedByName: text('last_edited_by_name').notNull(),
		lastEditedAt: text('last_edited_at').notNull(),
	},
	(table) => [primaryKey({ columns: [table.chapterId, table.channelId] })],
);

// A coalition row ties together the three identities one coalition has:
// `group_name` is the Solidarity custom-property internal_name (also the key
// the /coalition-invite webhook receives), `name` is the property's display
// label, `user_list_id` is the Solidarity user list that mirrors the property
// (the fast membership read path for reconciliation; nullable because
// pre-existing rows don't have one).
export const coalitionChannelMap = sqliteTable('coalition_channel_map', {
	groupName: text('group_name').primaryKey(),
	channelId: text('channel_id').notNull(),
	name: text('name').notNull().default(''),
	userListId: integer('user_list_id'),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

export const allowedSlackUsers = sqliteTable('allowed_slack_users', {
	slackUserId: text('slack_user_id').primaryKey(),
	displayName: text('display_name').notNull(),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

export const reportExcludedChapters = sqliteTable('report_excluded_chapters', {
	chapterId: integer('chapter_id').primaryKey(),
	reason: text('reason'),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

// Per-channel team_join behavior: whether the bot posts its "everybody
// welcome @X" message in the channel after inviting a new member. Row absent
// means the default (show the welcome message), so only channels an admin has
// toggled carry a row. Toggled from the chapter ↔ channel chips on /settings.
export const channelWelcomeFlags = sqliteTable('channel_welcome_flags', {
	channelId: text('channel_id').primaryKey(),
	showWelcomeMessage: integer('show_welcome_message', { mode: 'boolean' }).notNull(),
	lastEditedBy: text('last_edited_by').notNull(),
	lastEditedByName: text('last_edited_by_name').notNull(),
	lastEditedAt: text('last_edited_at').notNull(),
});

// One row per (ET date, conversation code): the code's total door-knock
// attempts/contacts for that day, captured by the nightly snapshot from
// Openfield's today-only leaderboard endpoint. chapter_name comes from the
// "Conversation Codes" Slack canvas at snapshot time.
export const doorKnockDaily = sqliteTable(
	'door_knock_daily',
	{
		date: text('date').notNull(),
		code: text('code').notNull(),
		chapterName: text('chapter_name').notNull(),
		attempts: integer('attempts').notNull().default(0),
		contacts: integer('contacts').notNull().default(0),
	},
	(table) => [primaryKey({ columns: [table.date, table.code] })],
);

// One row per (date, code, canvasser): an individual's door-knock attempts on
// that conversation for that day. Openfield's today-leaderboard already breaks
// its totals down per canvasser — door_knock_daily throws that detail away, so
// this table keeps it for the dashboard's daily personal ticker.
//
// Keyed by code as well as canvasser (rather than pre-summing per person)
// because the snapshot writes code by code and upserts; a mid-day re-run then
// overwrites exactly the rows it rewrote, the same contract door_knock_daily
// has. Summing across codes is the reader's job — one person can canvass under
// several codes in a day.
export const doorKnockCanvasserDaily = sqliteTable(
	'door_knock_canvasser_daily',
	{
		date: text('date').notNull(),
		code: text('code').notNull(),
		/** Openfield's display name for the canvasser, trimmed. */
		canvasser: text('canvasser').notNull(),
		attempts: integer('attempts').notNull().default(0),
		contacts: integer('contacts').notNull().default(0),
	},
	(table) => [primaryKey({ columns: [table.date, table.code, table.canvasser] })],
);

// Cache of conversation code → Openfield numeric conversation id. Resolving a
// code costs a POST to /codes/, so each code is resolved once and reused.
export const doorKnockCodeIds = sqliteTable('door_knock_code_ids', {
	code: text('code').primaryKey(),
	conversationId: integer('conversation_id').notNull(),
	resolvedAt: text('resolved_at').notNull(),
});

// Nightly archive of the "Conversation Codes" canvas HTML (~30 KB/night) —
// Slack has no canvas version-history API, so this is our own record of what
// the canvas said on each date. One row per ET date; a re-run the same
// evening overwrites with the fresher copy.
export const doorKnockCanvasArchive = sqliteTable('door_knock_canvas_archive', {
	date: text('date').primaryKey(),
	html: text('html').notNull(),
	fetchedAt: text('fetched_at').notNull(),
});

// Singleton row recording the last door-knock snapshot ATTEMPT, so dashboard
// visits can re-run the snapshot at most once every DOOR_KNOCK_REFRESH_MS
// (see door-knock-refresh.ts). Stamped at claim time — before the snapshot
// runs — so a failing Openfield/Slack call throttles the retry the same as a
// success instead of letting every page view start a new attempt.
export const doorKnockRefresh = sqliteTable(
	'door_knock_refresh',
	{
		id: integer('id').primaryKey(),
		/** ISO timestamp the attempt was claimed. */
		startedAt: text('started_at').notNull(),
		/** ISO timestamp the attempt settled; NULL while one is in flight. */
		finishedAt: text('finished_at'),
		ok: integer('ok', { mode: 'boolean' }),
		/** Error message of the last failed attempt, for debugging. */
		error: text('error'),
	},
	(table) => [check('door_knock_refresh_singleton', sql`${table.id} = 1`)],
);

export const appConfig = sqliteTable(
	'app_config',
	{
		id: integer('id').primaryKey(),
		slackTrackingChannelId: text('slack_tracking_channel_id'),
		slackGrowthReportChannelId: text('slack_growth_report_channel_id'),
		slackGrowthReportRankingAlpha: real('slack_growth_report_ranking_alpha'),
		// Header countdown (label + ISO end datetime). DB-only, no env fallback;
		// '' means "not configured" (the set-only save contract reserves NULL for
		// "use the fallback", so clearing writes '' rather than NULL).
		countdownLabel: text('countdown_label'),
		countdownEndAt: text('countdown_end_at'),
		// New-member welcome DM template. NULL / '' means "use the built-in
		// default" (see DEFAULT_WELCOME_DM). Stored raw with `{{channels}}` and
		// friendly `#channel-name` tokens; resolution happens at send time.
		welcomeDmMessage: text('welcome_dm_message'),
		lastEditedBy: text('last_edited_by').notNull(),
		lastEditedByName: text('last_edited_by_name').notNull(),
		lastEditedAt: text('last_edited_at').notNull(),
	},
	(table) => [check('app_config_singleton', sql`${table.id} = 1`)],
);

export type Request = typeof requests.$inferSelect;
export type NewRequest = typeof requests.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type SlackJoin = typeof slackJoins.$inferSelect;
export type NewSlackJoin = typeof slackJoins.$inferInsert;

export type SolidarityDailySnapshot = typeof solidarityDailySnapshots.$inferSelect;
export type NewSolidarityDailySnapshot = typeof solidarityDailySnapshots.$inferInsert;

export type WeeklyGrowthWindow = typeof weeklyGrowthWindows.$inferSelect;
export type NewWeeklyGrowthWindow = typeof weeklyGrowthWindows.$inferInsert;

export type WeeklyChapterGrowthRow = typeof weeklyChapterGrowth.$inferSelect;
export type NewWeeklyChapterGrowthRow = typeof weeklyChapterGrowth.$inferInsert;

export type ChapterChannelRow = typeof chapterChannelMap.$inferSelect;
export type NewChapterChannelRow = typeof chapterChannelMap.$inferInsert;

export type CoalitionChannelRow = typeof coalitionChannelMap.$inferSelect;
export type NewCoalitionChannelRow = typeof coalitionChannelMap.$inferInsert;

export type AllowedSlackUserRow = typeof allowedSlackUsers.$inferSelect;
export type NewAllowedSlackUserRow = typeof allowedSlackUsers.$inferInsert;

export type ExcludedChapterRow = typeof reportExcludedChapters.$inferSelect;
export type NewExcludedChapterRow = typeof reportExcludedChapters.$inferInsert;

export type ChannelWelcomeFlagRow = typeof channelWelcomeFlags.$inferSelect;
export type NewChannelWelcomeFlagRow = typeof channelWelcomeFlags.$inferInsert;

export type AppConfigRow = typeof appConfig.$inferSelect;
export type NewAppConfigRow = typeof appConfig.$inferInsert;

export type DoorKnockDailyRow = typeof doorKnockDaily.$inferSelect;
export type NewDoorKnockDailyRow = typeof doorKnockDaily.$inferInsert;

export type DoorKnockCanvasserDailyRow = typeof doorKnockCanvasserDaily.$inferSelect;
export type NewDoorKnockCanvasserDailyRow = typeof doorKnockCanvasserDaily.$inferInsert;

export type DoorKnockCodeIdRow = typeof doorKnockCodeIds.$inferSelect;
export type NewDoorKnockCodeIdRow = typeof doorKnockCodeIds.$inferInsert;

export type DoorKnockCanvasArchiveRow = typeof doorKnockCanvasArchive.$inferSelect;
export type NewDoorKnockCanvasArchiveRow = typeof doorKnockCanvasArchive.$inferInsert;

export type DoorKnockRefreshRow = typeof doorKnockRefresh.$inferSelect;
export type NewDoorKnockRefreshRow = typeof doorKnockRefresh.$inferInsert;

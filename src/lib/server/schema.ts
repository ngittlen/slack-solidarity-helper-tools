import {
	sqliteTable,
	text,
	integer,
	real,
	index,
	uniqueIndex,
	primaryKey,
	check,
} from 'drizzle-orm/sqlite-core';
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

// One row per (date, turf code): the turf's total door-knock attempts/contacts
// for that day, captured by the nightly snapshot from whichever door-knock
// provider is configured (see door-knock-provider.ts). `code` and
// `chapter_name` mean whatever that provider says they mean — for Openfield, a
// conversation code and the chapter the "Conversation Codes" Slack canvas
// attributed it to at snapshot time. The date is likewise stamped in the
// provider's rollover zone, NOT necessarily the campaign's.
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
// that turf for that day. Providers already break their totals down per
// canvasser — door_knock_daily throws that detail away, so this table keeps it
// for the dashboard's daily personal ticker.
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
		/** The provider's display name for the canvasser, trimmed. */
		canvasser: text('canvasser').notNull(),
		/** Chapter the code belonged to that day, denormalised from the canvas
		 *  the same way door_knock_daily stores it — so the ticker can name a
		 *  canvasser's region without joining back on (date, code). Defaulted
		 *  because it was added after the table; every row the snapshot writes
		 *  sets it. */
		chapterName: text('chapter_name').notNull().default(''),
		attempts: integer('attempts').notNull().default(0),
		contacts: integer('contacts').notNull().default(0),
	},
	(table) => [primaryKey({ columns: [table.date, table.code, table.canvasser] })],
);

// Openfield provider only. Cache of conversation code → Openfield numeric
// conversation id. Resolving a code costs a POST to /codes/, so each code is
// resolved once and reused.
export const doorKnockCodeIds = sqliteTable('door_knock_code_ids', {
	code: text('code').primaryKey(),
	conversationId: integer('conversation_id').notNull(),
	resolvedAt: text('resolved_at').notNull(),
});

// Openfield provider only. Nightly archive of the "Conversation Codes" canvas
// HTML (~30 KB/night) — Slack has no canvas version-history API, so this is
// our own record of what the canvas said on each date. One row per date; a
// re-run the same evening overwrites with the fresher copy.
export const doorKnockCanvasArchive = sqliteTable('door_knock_canvas_archive', {
	date: text('date').primaryKey(),
	html: text('html').notNull(),
	fetchedAt: text('fetched_at').notNull(),
});

// Singleton row recording the last door-knock snapshot ATTEMPT, so dashboard
// visits can re-run the snapshot at most once every DOOR_KNOCK_REFRESH_MS
// (see door-knock-refresh.ts). Stamped at claim time — before the snapshot
// runs — so a failing provider/Slack call throttles the retry the same as a
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
		// Where the nightly Mobilize/attendee sync posts its alerts. NULL means
		// "wherever the growth report goes" — the fallback these alerts had
		// before this column existed. No env var of its own.
		slackMobilizeSyncChannelId: text('slack_mobilize_sync_channel_id'),
		// Admin channel that gets a line every time a member note or warning is
		// logged, so moderation stays visible to the whole admin group rather
		// than only to whoever filed it. NULL means "don't post" — the feature
		// is opt-in, and an unconfigured channel must not be an error path.
		slackMemberNoteChannelId: text('slack_member_note_channel_id'),
		// Contact published on events the sync creates in Mobilize. The v1 API
		// requires a contact on every create and update, and Solidarity events
		// carry none, so it is configured here. NULL falls back to
		// MOBILIZE_CONTACT_NAME / _EMAIL / _PHONE.
		mobilizeContactName: text('mobilize_contact_name'),
		mobilizeContactEmail: text('mobilize_contact_email'),
		mobilizeContactPhone: text('mobilize_contact_phone'),
		// Header countdown (label + ISO end datetime). DB-only, no env fallback;
		// '' means "not configured" (the set-only save contract reserves NULL for
		// "use the fallback", so clearing writes '' rather than NULL).
		countdownLabel: text('countdown_label'),
		countdownEndAt: text('countdown_end_at'),
		// New-member welcome DM template. NULL / '' means "use the built-in
		// default" (see DEFAULT_WELCOME_DM). Stored raw with `{{channels}}` and
		// friendly `#channel-name` tokens; resolution happens at send time.
		welcomeDmMessage: text('welcome_dm_message'),
		// Template for the DM a member receives when an admin logs a warning
		// against them. NULL / '' means "use the built-in default" (see
		// DEFAULT_WARNING_DM). Stored raw with `{{nth}}`, `{{note}}`,
		// `{{message_link}}` and friendly `#channel-name` tokens; all resolved at
		// send time. An admin can also override the text per-warning in the Slack
		// modal without changing this template.
		warningDmMessage: text('warning_dm_message'),
		// Door-knock ticker scroll speed in LED columns per second. DB-only,
		// no env fallback; NULL means DEFAULT_TICKER_COLUMNS_PER_SECOND.
		doorTickerColumnsPerSecond: real('door_ticker_columns_per_second'),
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

// Ledger for the nightly Solidarity -> Mobilize event sync. Mobilize has no
// public write API and no way to tag an event with its Solidarity origin, so
// this mapping is the only reliable record of what we created — without it a
// re-run would publish duplicate events volunteers could sign up for.
export const mobilizeSyncedEvents = sqliteTable('mobilize_synced_events', {
	// `solidarity:<eventId>:<location>` — one Solidarity event can span several
	// locations and therefore several Mobilize events.
	key: text('key').primaryKey(),
	mobilizeEventId: integer('mobilize_event_id').notNull(),
	title: text('title').notNull(),
	createdAt: text('created_at').notNull(),
	lastSyncedAt: text('last_synced_at'),
});

// Solidarity image URL -> the copy re-hosted in Mobilize's bucket. Keyed by
// source so an image shared across events uploads once.
export const mobilizeSyncedImages = sqliteTable('mobilize_synced_images', {
	sourceUrl: text('source_url').primaryKey(),
	mobilizeUrl: text('mobilize_url').notNull(),
	uploadedAt: text('uploaded_at').notNull(),
});

// Venue coordinates -> postal code. `postal_code` is the one location field
// Mobilize requires and a third of Solidarity's sessions have no zip anywhere in
// them, so it is geocoded from the coordinates they do carry. Cached because a
// venue's zip never changes and the campaign runs the same offices all season.
export const mobilizeGeocodedZips = sqliteTable('mobilize_geocoded_zips', {
	// "42.98372,-83.67487" — see pointKey() in mobilize-migrator/lib/geocode.ts.
	point: text('point').primaryKey(),
	postalCode: text('postal_code').notNull(),
	lookedUpAt: text('looked_up_at').notNull(),
});

export type MobilizeGeocodedZipRow = typeof mobilizeGeocodedZips.$inferSelect;
export type NewMobilizeGeocodedZipRow = typeof mobilizeGeocodedZips.$inferInsert;

export type MobilizeSyncedEventRow = typeof mobilizeSyncedEvents.$inferSelect;
export type NewMobilizeSyncedEventRow = typeof mobilizeSyncedEvents.$inferInsert;

export type MobilizeSyncedImageRow = typeof mobilizeSyncedImages.$inferSelect;
export type NewMobilizeSyncedImageRow = typeof mobilizeSyncedImages.$inferInsert;

// --- Mobilize -> Solidarity attendee sync -------------------------------------

// Maps a Mobilize timeslot to the Solidarity event session it came from.
// Written during the event sync (reconcileTimeslots already pairs them), so the
// attendee sync can resolve a signup to a session without re-planning.
export const mobilizeSyncedTimeslots = sqliteTable('mobilize_synced_timeslots', {
	mobilizeTimeslotId: integer('mobilize_timeslot_id').primaryKey(),
	mobilizeEventId: integer('mobilize_event_id').notNull(),
	// NOTE: Solidarity's own event id. Its API confusingly calls this
	// `mobilize_event_id` — "mobilize_event" is Solidarity's internal name for
	// its event entity and has nothing to do with mobilize.us.
	solidarityEventId: integer('solidarity_event_id').notNull(),
	solidaritySessionId: integer('solidarity_session_id').notNull(),
	updatedAt: text('updated_at').notNull(),
});

// One row per Mobilize signup we've mirrored. `mobilizeModifiedDate` lets a run
// skip rows that haven't changed; `status` records what we last wrote so a
// cancellation is only pushed once.
export const mobilizeSyncedRsvps = sqliteTable('mobilize_synced_rsvps', {
	mobilizeAttendanceId: integer('mobilize_attendance_id').primaryKey(),
	solidarityRsvpId: integer('solidarity_rsvp_id'),
	solidarityUserId: integer('solidarity_user_id').notNull(),
	solidaritySessionId: integer('solidarity_session_id').notNull(),
	status: text('status').notNull(),
	attended: integer('attended', { mode: 'boolean' }).notNull().default(false),
	mobilizeModifiedDate: integer('mobilize_modified_date').notNull().default(0),
	syncedAt: text('synced_at').notNull(),
});

// zip -> chapter, derived from where existing members actually belong.
// Solidarity chapters carry no geographic data, so this is rebuilt nightly from
// the membership base rather than fetched.
export const zipChapterMap = sqliteTable('zip_chapter_map', {
	zipCode: text('zip_code').primaryKey(),
	chapterId: integer('chapter_id').notNull(),
	// How many members in this zip belong to that chapter — a low count means a
	// weak guess, useful when auditing where the sync put people.
	memberCount: integer('member_count').notNull().default(0),
	updatedAt: text('updated_at').notNull(),
});

// One row per long-running sync that must not overlap itself. Cancelling a
// GitHub Actions run does not stop the request it fired — nothing propagates the
// cancellation to Fly — so a re-run can start while the previous sync is still
// writing. Two runs then snapshot the ledger before either has written to it and
// both attempt the same Solidarity creates.
//
// `expiresAt` makes the lock self-healing: a process that dies without releasing
// would otherwise wedge the sync forever. Stored as an ISO-8601 UTC string,
// which is fixed-width, so lexicographic comparison is chronological.
//
// `token` identifies the holder, so a run that overran its TTL and lost the lock
// cannot release the lock a newer run now holds.
export const syncLocks = sqliteTable('sync_locks', {
	name: text('name').primaryKey(),
	token: text('token').notNull(),
	acquiredAt: text('acquired_at').notNull(),
	expiresAt: text('expires_at').notNull(),
});

export type MobilizeSyncedTimeslotRow = typeof mobilizeSyncedTimeslots.$inferSelect;
export type NewMobilizeSyncedTimeslotRow = typeof mobilizeSyncedTimeslots.$inferInsert;

export type MobilizeSyncedRsvpRow = typeof mobilizeSyncedRsvps.$inferSelect;
export type NewMobilizeSyncedRsvpRow = typeof mobilizeSyncedRsvps.$inferInsert;

export type ZipChapterRow = typeof zipChapterMap.$inferSelect;
export type NewZipChapterRow = typeof zipChapterMap.$inferInsert;

// ---------------------------------------------------------------------------
// Member lookup + moderation notes
// ---------------------------------------------------------------------------

// Admin-made Slack -> Solidarity account links, for the members whose Slack
// email doesn't match any Solidarity record. Consulted by the member lookup
// page *before* it falls back to matching on email: an explicit human decision
// has to outrank the heuristic, or someone who later corrects their Solidarity
// email would silently re-point to a different record than the one an admin
// deliberately picked.
export const memberAccountLinks = sqliteTable(
	'member_account_links',
	{
		// One Slack account maps to at most one Solidarity account, so the Slack
		// id is the key — the page read is a point lookup and re-linking is a
		// plain onConflictDoUpdate.
		slackUserId: text('slack_user_id').primaryKey(),
		solidarityUserId: integer('solidarity_user_id').notNull(),
		// The Solidarity email as it read when the link was made. Audit trail
		// only — never a lookup key, since the whole reason a link exists is that
		// the emails don't line up.
		solidarityEmail: text('solidarity_email'),
		linkedBy: text('linked_by').notNull(),
		linkedByName: text('linked_by_name').notNull(),
		linkedAt: text('linked_at').notNull(),
	},
	// Deliberately NOT uniqueIndex: duplicate Solidarity records exist, and a
	// mis-link has to be correctable rather than blowing up mid-request. The
	// index is here for reverse lookups.
	(table) => [index('member_account_links_solidarity_user_id').on(table.solidarityUserId)],
);

// Append-only moderation log: notes and warnings admins record about a Slack
// member, written from the Slack modal and read by the member lookup page.
//
// Keyed by Slack user id, not Solidarity id: both entry points (the users_select
// in the modal, the author of a shortcut's message) produce a Slack id, and
// plenty of members have no Solidarity account at all. memberAccountLinks is
// the join when Solidarity data is needed.
export const memberNotes = sqliteTable(
	'member_notes',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		slackUserId: text('slack_user_id').notNull(),
		// drizzle's `enum` is compile-time only, so the check constraint below is
		// what actually keeps junk out of the column.
		kind: text('kind', { enum: ['note', 'warning'] }).notNull(),
		body: text('body').notNull(),
		// Permalink to the Slack message the note is about, when there is one.
		// The raw URL is what we render — always clickable, and immune to
		// permalink format changes.
		messageLink: text('message_link'),
		// Parsed from messageLink at write time. Kept alongside the raw URL so a
		// fresh permalink can be re-resolved via chat.getPermalink after a channel
		// rename without re-parsing.
		messageChannelId: text('message_channel_id'),
		messageTs: text('message_ts'),
		// All-time warning rank at insert time, 1-based; NULL for kind='note'.
		// Persisted rather than derived so the DM and the page agree forever —
		// recomputing after a future delete would silently renumber history.
		warningNumber: integer('warning_number'),
		// What the admin chose in the modal, kept separately from the outcome so
		// "chose not to notify" stays distinguishable from "tried and failed".
		dmRequested: integer('dm_requested', { mode: 'boolean' }).notNull().default(false),
		dmSentAt: text('dm_sent_at'),
		// 'suppressed' | 'not-a-warning' | an error message. NULL once sent.
		dmStatus: text('dm_status'),
		// The fully rendered message actually delivered. Needed because admins can
		// edit the warning text per-warning in the modal, so the template alone
		// can't tell you what this member was told.
		dmBody: text('dm_body'),
		// Snapshot of the author's name at write time, matching the settings
		// tables — names change, and the log should render what it said then.
		authorSlackUserId: text('author_slack_user_id').notNull(),
		authorSlackUserName: text('author_slack_user_name').notNull(),
		createdAt: text('created_at').notNull(),
		source: text('source', { enum: ['slash', 'shortcut'] })
			.notNull()
			.default('slash'),
	},
	(table) => [
		index('member_notes_slack_user_created').on(table.slackUserId, table.createdAt),
		// Makes the insert-then-rank warning count (see member-notes.ts) an
		// index-only scan.
		index('member_notes_warning_rank').on(table.slackUserId, table.kind, table.id),
		check('member_notes_kind_check', sql`${table.kind} in ('note', 'warning')`),
		check('member_notes_source_check', sql`${table.source} in ('slash', 'shortcut')`),
	],
);

export type MemberAccountLinkRow = typeof memberAccountLinks.$inferSelect;
export type NewMemberAccountLinkRow = typeof memberAccountLinks.$inferInsert;

export type MemberNoteRow = typeof memberNotes.$inferSelect;
export type NewMemberNoteRow = typeof memberNotes.$inferInsert;

/**
 * Every place a Slack invite link is currently published in Solidarity, one row
 * per (page, location, link), refreshed by the hourly invite audit.
 *
 * A ledger rather than a scan cache: Solidarity exposes no `updated_at` on
 * pages and its public pages send no ETag, so this table is the only record of
 * *when* a link appeared on a page or *when* it went bad. `firstSeenAt` answers
 * "how long have volunteers been hitting a dead link here", and
 * `statusChangedAt` plus `previousStatus` make the transition visible even
 * though the audit re-checks everything from scratch each run.
 *
 * Rows are kept after a link disappears from a page (`lastSeenAt` stops
 * advancing) — deleting them would erase the history of a fix.
 */
export const slackInviteSightings = sqliteTable(
	'slack_invite_sightings',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		pageId: integer('page_id').notNull(),
		// Snapshotted so the log still reads correctly after a page is renamed.
		pageName: text('page_name').notNull(),
		pageUrl: text('page_url').notNull().default(''),
		// 'page content' | 'redirect URL' | 'follow-up email' | 'follow-up text'
		location: text('location').notNull(),
		url: text('url').notNull(),
		// 'valid' | 'broken' | 'unknown'
		status: text('status').notNull(),
		detail: text('detail').notNull().default(''),
		previousStatus: text('previous_status'),
		firstSeenAt: text('first_seen_at').notNull(),
		lastSeenAt: text('last_seen_at').notNull(),
		statusChangedAt: text('status_changed_at'),
	},
	(table) => [
		// The natural key of a sighting: the same link in the email and in the
		// text of one page are two independent things to fix.
		uniqueIndex('slack_invite_sightings_page_location_url').on(
			table.pageId,
			table.location,
			table.url,
		),
		index('slack_invite_sightings_status').on(table.status, table.lastSeenAt),
		check(
			'slack_invite_sightings_status_check',
			sql`${table.status} in ('valid', 'broken', 'unknown')`,
		),
	],
);

export type SlackInviteSightingRow = typeof slackInviteSightings.$inferSelect;
export type NewSlackInviteSightingRow = typeof slackInviteSightings.$inferInsert;

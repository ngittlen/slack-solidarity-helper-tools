import { sqliteTable, text, integer, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

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

export type Request = typeof requests.$inferSelect;
export type NewRequest = typeof requests.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type SlackJoin = typeof slackJoins.$inferSelect;
export type NewSlackJoin = typeof slackJoins.$inferInsert;

export type SolidarityDailySnapshot = typeof solidarityDailySnapshots.$inferSelect;
export type NewSolidarityDailySnapshot = typeof solidarityDailySnapshots.$inferInsert;

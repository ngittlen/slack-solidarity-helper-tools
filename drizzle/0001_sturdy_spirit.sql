CREATE TABLE IF NOT EXISTS `slack_joins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slack_user_id` text NOT NULL,
	`email` text,
	`joined_at` text NOT NULL,
	`chapter_ids` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `slack_joins_slack_user_id_unique` ON `slack_joins` (`slack_user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `solidarity_daily_snapshots` (
	`date` text NOT NULL,
	`chapter_id` integer DEFAULT -1 NOT NULL,
	`chapter_name` text,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `chapter_id`)
);

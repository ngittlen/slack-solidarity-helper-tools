CREATE TABLE `allowed_slack_users` (
	`slack_user_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`slack_tracking_channel_id` text,
	`slack_growth_report_channel_id` text,
	`slack_growth_report_ranking_alpha` real,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL,
	CONSTRAINT "app_config_singleton" CHECK("app_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `chapter_channel_map` (
	`chapter_id` integer PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`name` text NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `coalition_channel_map` (
	`group_name` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `report_excluded_chapters` (
	`chapter_id` integer PRIMARY KEY NOT NULL,
	`reason` text,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);

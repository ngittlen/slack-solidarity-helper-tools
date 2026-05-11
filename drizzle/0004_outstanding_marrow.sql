CREATE TABLE `weekly_chapter_growth` (
	`window_end` text NOT NULL,
	`chapter_id` integer NOT NULL,
	`chapter_name` text NOT NULL,
	`slack_channel_id` text,
	`new_joins` integer NOT NULL,
	`existing` integer NOT NULL,
	`num_members` integer,
	PRIMARY KEY(`window_end`, `chapter_id`)
);
--> statement-breakpoint
CREATE TABLE `weekly_growth_windows` (
	`window_end` text PRIMARY KEY NOT NULL,
	`window_start` text NOT NULL,
	`total_new_joins` integer NOT NULL,
	`computed_at` text NOT NULL
);

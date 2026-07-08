CREATE TABLE `door_knock_code_ids` (
	`code` text PRIMARY KEY NOT NULL,
	`conversation_id` integer NOT NULL,
	`resolved_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `door_knock_daily` (
	`date` text NOT NULL,
	`code` text NOT NULL,
	`chapter_name` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`contacts` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `code`)
);

CREATE TABLE `mentor_walks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mentor_id` text NOT NULL,
	`mentor_name` text NOT NULL,
	`chapter_id` integer NOT NULL,
	`starts_at` text NOT NULL,
	`place` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`note` text,
	`seats` integer NOT NULL,
	`phone` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`status_by` text,
	`status_by_name` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mentor_walks_mentor` ON `mentor_walks` (`mentor_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `mentor_walks_chapter` ON `mentor_walks` (`chapter_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `mentors` (
	`holder_id` text PRIMARY KEY NOT NULL,
	`holder_name` text NOT NULL,
	`status` text NOT NULL,
	`snoozed_until` text,
	`agreed_at` text,
	`agreed_url` text,
	`appointed_by` text,
	`appointed_by_name` text,
	`revoked_by` text,
	`revoked_by_name` text,
	`revoked_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `app_config` ADD `mentor_walks_visibility` text;--> statement-breakpoint
ALTER TABLE `app_config` ADD `volunteer_guidelines_url` text;
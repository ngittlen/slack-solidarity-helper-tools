CREATE TABLE IF NOT EXISTS `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text,
	`name` text,
	`phone` text,
	`comment` text,
	`requested_at` text NOT NULL,
	`helped` integer DEFAULT 0 NOT NULL,
	`last_edited_by_id` text,
	`last_edited_by_name` text,
	`status` text DEFAULT 'uncontacted' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requests_email_unique` ON `requests` (`email`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`sid` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`expires_at` text NOT NULL
);

CREATE TABLE `mentor_walk_alerts` (
	`holder_id` text PRIMARY KEY NOT NULL,
	`holder_name` text NOT NULL,
	`zip` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`radius_miles` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mentor_walk_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`holder_id` text NOT NULL,
	`walk_id` integer,
	`event_key` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`claimed_at` text,
	`sent_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mentor_walk_messages_event` ON `mentor_walk_messages` (`holder_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `mentor_walk_messages_status` ON `mentor_walk_messages` (`status`);--> statement-breakpoint
CREATE TABLE `mentor_walk_prompts` (
	`holder_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`snoozed_until` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mentor_walk_seats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`walk_id` integer NOT NULL,
	`holder_id` text NOT NULL,
	`holder_name` text NOT NULL,
	`joined_at` text NOT NULL,
	`left_at` text,
	`join_count` integer DEFAULT 1 NOT NULL,
	`was_new` integer DEFAULT false NOT NULL,
	`mentor_ticked` integer DEFAULT false NOT NULL,
	`answer` text,
	`answered_at` text,
	`report_posted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mentor_walk_seats_walk_holder` ON `mentor_walk_seats` (`walk_id`,`holder_id`);--> statement-breakpoint
CREATE INDEX `mentor_walk_seats_holder` ON `mentor_walk_seats` (`holder_id`);--> statement-breakpoint
ALTER TABLE `mentor_walks` ADD `look_for` text;--> statement-breakpoint
ALTER TABLE `mentor_walks` ADD `checked_in_at` text;--> statement-breakpoint
ALTER TABLE `mentor_walks` ADD `no_show_channel` text;--> statement-breakpoint
ALTER TABLE `mentor_walks` ADD `no_show_ts` text;--> statement-breakpoint
ALTER TABLE `mentor_walks` ADD `no_show_claimed_at` text;
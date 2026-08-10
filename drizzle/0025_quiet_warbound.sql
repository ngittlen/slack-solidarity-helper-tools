CREATE TABLE `slack_invite_sightings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`page_id` integer NOT NULL,
	`page_name` text NOT NULL,
	`page_url` text DEFAULT '' NOT NULL,
	`location` text NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`previous_status` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`status_changed_at` text,
	CONSTRAINT "slack_invite_sightings_status_check" CHECK("slack_invite_sightings"."status" in ('valid', 'broken', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_invite_sightings_page_location_url` ON `slack_invite_sightings` (`page_id`,`location`,`url`);--> statement-breakpoint
CREATE INDEX `slack_invite_sightings_status` ON `slack_invite_sightings` (`status`,`last_seen_at`);
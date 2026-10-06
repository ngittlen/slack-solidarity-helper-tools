CREATE TABLE `mobilize_imported_events` (
	`mobilize_event_id` integer PRIMARY KEY NOT NULL,
	`source_org_id` integer NOT NULL,
	`solidarity_event_id` integer,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`solidarity_page_url` text,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`stalled_reported_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mobilize_imported_timeslots` (
	`mobilize_timeslot_id` integer PRIMARY KEY NOT NULL,
	`mobilize_event_id` integer NOT NULL,
	`solidarity_session_id` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `app_config` ADD `mobilize_import_tag` text;
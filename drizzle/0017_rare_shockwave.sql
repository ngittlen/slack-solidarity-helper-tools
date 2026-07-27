CREATE TABLE `mobilize_synced_events` (
	`key` text PRIMARY KEY NOT NULL,
	`mobilize_event_id` integer NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`last_synced_at` text
);
--> statement-breakpoint
CREATE TABLE `mobilize_synced_images` (
	`source_url` text PRIMARY KEY NOT NULL,
	`mobilize_url` text NOT NULL,
	`uploaded_at` text NOT NULL
);

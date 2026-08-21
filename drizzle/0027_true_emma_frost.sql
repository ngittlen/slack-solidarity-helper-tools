CREATE TABLE `van_blocked_users` (
	`slack_user_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`reason` text,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `van_chapter_folders` (
	`chapter_id` integer NOT NULL,
	`folder_id` integer NOT NULL,
	`chapter_name` text NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL,
	PRIMARY KEY(`chapter_id`, `folder_id`)
);
--> statement-breakpoint
CREATE TABLE `van_geometry_queue` (
	`map_route_id` integer PRIMARY KEY NOT NULL,
	`saved_list_id` integer NOT NULL,
	`export_job_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`requested_at` text,
	`completed_at` text,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `van_geometry_queue_status` ON `van_geometry_queue` (`status`);--> statement-breakpoint
CREATE TABLE `van_turf_checkouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`map_route_id` integer NOT NULL,
	`slack_user_id` text NOT NULL,
	`slack_user_name` text NOT NULL,
	`claimed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`released_at` text,
	`completed_at` text,
	`release_reason` text,
	`confirmed_door_delta` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `van_turf_checkouts_one_active` ON `van_turf_checkouts` (`map_route_id`) WHERE "van_turf_checkouts"."released_at" IS NULL AND "van_turf_checkouts"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `van_turf_checkouts_holder` ON `van_turf_checkouts` (`slack_user_id`);--> statement-breakpoint
CREATE TABLE `van_turfs` (
	`map_route_id` integer PRIMARY KEY NOT NULL,
	`map_region_id` integer NOT NULL,
	`folder_id` integer NOT NULL,
	`chapter_id` integer NOT NULL,
	`chapter_name` text DEFAULT '' NOT NULL,
	`region_name` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`saved_list_id` integer,
	`printed_list_number` text,
	`route_number` integer,
	`route_size` integer DEFAULT 0 NOT NULL,
	`door_count` integer DEFAULT 0 NOT NULL,
	`phone_count` integer DEFAULT 0 NOT NULL,
	`centroid_lat` real,
	`centroid_lng` real,
	`hull_json` text,
	`hull_source_route_size` integer,
	`van_distributed_to` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_refreshed_at` text,
	`retired_at` text
);
--> statement-breakpoint
CREATE INDEX `van_turfs_chapter` ON `van_turfs` (`chapter_id`);--> statement-breakpoint
CREATE INDEX `van_turfs_region` ON `van_turfs` (`map_region_id`);--> statement-breakpoint
CREATE TABLE `van_zip_centroids` (
	`zip` text PRIMARY KEY NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`fetched_at` text NOT NULL
);

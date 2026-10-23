CREATE TABLE `van_turf_placements` (
	`turf_id` integer PRIMARY KEY NOT NULL,
	`chapter_id` integer NOT NULL,
	`chapter_name` text NOT NULL,
	`source` text NOT NULL,
	`zip` text,
	`zip_checked` integer DEFAULT false NOT NULL,
	`centroid_lat` real,
	`centroid_lng` real,
	`placed_at` text NOT NULL,
	`placed_by_name` text
);
--> statement-breakpoint
ALTER TABLE `van_campaigns` ADD `requested_folder_id` integer;
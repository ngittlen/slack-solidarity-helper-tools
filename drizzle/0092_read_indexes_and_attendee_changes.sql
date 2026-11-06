CREATE TABLE `attendee_sync_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`changes_from` integer NOT NULL,
	`retry_event_ids` text DEFAULT '[]' NOT NULL,
	`full_read_at` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `van_turf_placements_chapter` ON `van_turf_placements` (`chapter_id`,`turf_id`);--> statement-breakpoint
CREATE INDEX `van_turfs_live_centroid` ON `van_turfs` (`centroid_lat`,`centroid_lng`,`campaign_id`,`folder_id`,`hidden_at`,`retired_at`) WHERE "van_turfs"."retired_at" IS NULL;--> statement-breakpoint
-- Planner statistics for these indexes, which the nightly refresh
-- (planner-stats.ts) would otherwise be first to give them: without any,
-- the planner guesses at an index and may not use it. About a second in all.
ANALYZE `van_turfs`;--> statement-breakpoint
ANALYZE `van_turf_placements`;

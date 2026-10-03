-- Campaign-scoped keys (specs/012-multi-van-campaigns/spec.md, Phase 2).
--
-- Every id VAN hands out — folder, region, route, MiniVAN export — is unique
-- only within one committee, so each table keyed by one gains `campaign_id`.
-- Existing rows all belong to the campaign the app has always served, which
-- the 0054 migration seeded as van_campaigns row 1.
--
-- van_turfs keeps `turf_id` as the app's own id and gains `van_map_route_id`
-- for VAN's. They are equal on every existing row, so nothing already handed
-- out — Slack buttons, webhook URLs, checkouts — changes meaning.
--
-- The two singletons (van_sync_state, van_contact_sync_state) become one row
-- per campaign; their existing row has id 1, which is campaign 1.
-- van_sync_state.last_sync_at becomes nullable: a campaign whose first sync
-- fails still needs a row to record why.
--
-- SQLite cannot change a primary key or add a NOT NULL column without a default
-- in place, so each table is rebuilt: create, copy, drop, rename.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_van_turfs` (
	`turf_id` integer PRIMARY KEY NOT NULL,
	`campaign_id` integer DEFAULT 1 NOT NULL,
	`van_map_route_id` integer NOT NULL,
	`map_region_id` integer NOT NULL,
	`folder_id` integer NOT NULL,
	`chapter_id` integer NOT NULL,
	`chapter_name` text DEFAULT '' NOT NULL,
	`region_name` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`saved_list_id` integer,
	`printed_list_number` text,
	`printed_list_created_at` text,
	`list_expiry_warned_for` text,
	`route_number` integer,
	`route_size` integer DEFAULT 0 NOT NULL,
	`door_count` integer DEFAULT 0 NOT NULL,
	`phone_count` integer DEFAULT 0 NOT NULL,
	`centroid_lat` real,
	`centroid_lng` real,
	`hull_json` text,
	`hull_source_route_size` integer,
	`van_distributed_to` text,
	`van_assigned_at` text,
	`sheet_assigned_to` text,
	`drift_alerted_at` text,
	`drift_alerted_kind` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_refreshed_at` text,
	`cut_at` text,
	`uncontacted_doors` integer,
	`uncontacted_doors_at` text,
	`roster_saved_list_id` integer,
	`retired_at` text
);--> statement-breakpoint
INSERT INTO `__new_van_turfs` (`turf_id`, `campaign_id`, `van_map_route_id`, `map_region_id`, `folder_id`, `chapter_id`, `chapter_name`, `region_name`, `name`, `saved_list_id`, `printed_list_number`, `printed_list_created_at`, `list_expiry_warned_for`, `route_number`, `route_size`, `door_count`, `phone_count`, `centroid_lat`, `centroid_lng`, `hull_json`, `hull_source_route_size`, `van_distributed_to`, `van_assigned_at`, `sheet_assigned_to`, `drift_alerted_at`, `drift_alerted_kind`, `first_seen_at`, `last_seen_at`, `last_refreshed_at`, `cut_at`, `uncontacted_doors`, `uncontacted_doors_at`, `roster_saved_list_id`, `retired_at`)
SELECT `turf_id`, 1, `turf_id`, `map_region_id`, `folder_id`, `chapter_id`, `chapter_name`, `region_name`, `name`, `saved_list_id`, `printed_list_number`, `printed_list_created_at`, `list_expiry_warned_for`, `route_number`, `route_size`, `door_count`, `phone_count`, `centroid_lat`, `centroid_lng`, `hull_json`, `hull_source_route_size`, `van_distributed_to`, `van_assigned_at`, `sheet_assigned_to`, `drift_alerted_at`, `drift_alerted_kind`, `first_seen_at`, `last_seen_at`, `last_refreshed_at`, `cut_at`, `uncontacted_doors`, `uncontacted_doors_at`, `roster_saved_list_id`, `retired_at` FROM `van_turfs`;--> statement-breakpoint
DROP TABLE `van_turfs`;--> statement-breakpoint
ALTER TABLE `__new_van_turfs` RENAME TO `van_turfs`;--> statement-breakpoint
CREATE INDEX `van_turfs_chapter` ON `van_turfs` (`chapter_id`);--> statement-breakpoint
CREATE INDEX `van_turfs_region` ON `van_turfs` (`map_region_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `van_turfs_campaign_route` ON `van_turfs` (`campaign_id`,`van_map_route_id`);--> statement-breakpoint
CREATE INDEX `van_turfs_campaign_folder` ON `van_turfs` (`campaign_id`,`folder_id`);--> statement-breakpoint
CREATE TABLE `__new_van_chapter_folders` (
	`campaign_id` integer DEFAULT 1 NOT NULL,
	`chapter_id` integer NOT NULL,
	`folder_id` integer NOT NULL,
	`chapter_name` text NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL,
	PRIMARY KEY(`campaign_id`, `chapter_id`, `folder_id`)
);--> statement-breakpoint
INSERT INTO `__new_van_chapter_folders` (`campaign_id`, `chapter_id`, `folder_id`, `chapter_name`, `last_edited_by`, `last_edited_by_name`, `last_edited_at`)
SELECT 1, `chapter_id`, `folder_id`, `chapter_name`, `last_edited_by`, `last_edited_by_name`, `last_edited_at` FROM `van_chapter_folders`;--> statement-breakpoint
DROP TABLE `van_chapter_folders`;--> statement-breakpoint
ALTER TABLE `__new_van_chapter_folders` RENAME TO `van_chapter_folders`;--> statement-breakpoint
CREATE TABLE `__new_van_region_refreshes` (
	`campaign_id` integer DEFAULT 1 NOT NULL,
	`folder_id` integer NOT NULL,
	`map_region_id` integer NOT NULL,
	`requested_at` text,
	`last_request_at` text,
	`last_request_kind` text,
	`in_flight_since` text,
	`last_error` text,
	`last_error_at` text,
	PRIMARY KEY(`campaign_id`, `folder_id`, `map_region_id`)
);--> statement-breakpoint
INSERT INTO `__new_van_region_refreshes` (`campaign_id`, `folder_id`, `map_region_id`, `requested_at`, `last_request_at`, `last_request_kind`, `in_flight_since`, `last_error`, `last_error_at`)
SELECT 1, `folder_id`, `map_region_id`, `requested_at`, `last_request_at`, `last_request_kind`, `in_flight_since`, `last_error`, `last_error_at` FROM `van_region_refreshes`;--> statement-breakpoint
DROP TABLE `van_region_refreshes`;--> statement-breakpoint
ALTER TABLE `__new_van_region_refreshes` RENAME TO `van_region_refreshes`;--> statement-breakpoint
CREATE TABLE `__new_van_minivan_exports` (
	`campaign_id` integer DEFAULT 1 NOT NULL,
	`minivan_export_id` integer NOT NULL,
	`name` text,
	`list_number` text,
	`date_created` text,
	`canvassers_json` text DEFAULT '[]' NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`campaign_id`, `minivan_export_id`)
);--> statement-breakpoint
INSERT INTO `__new_van_minivan_exports` (`campaign_id`, `minivan_export_id`, `name`, `list_number`, `date_created`, `canvassers_json`, `fetched_at`)
SELECT 1, `minivan_export_id`, `name`, `list_number`, `date_created`, `canvassers_json`, `fetched_at` FROM `van_minivan_exports`;--> statement-breakpoint
DROP TABLE `van_minivan_exports`;--> statement-breakpoint
ALTER TABLE `__new_van_minivan_exports` RENAME TO `van_minivan_exports`;--> statement-breakpoint
CREATE INDEX `van_minivan_exports_list_number` ON `van_minivan_exports` (`campaign_id`,`list_number`);--> statement-breakpoint
CREATE INDEX `van_minivan_exports_date_created` ON `van_minivan_exports` (`campaign_id`,`date_created`);--> statement-breakpoint
CREATE TABLE `__new_van_person_contacts` (
	`campaign_id` integer DEFAULT 1 NOT NULL,
	`person_hash` blob NOT NULL,
	`last_in_person_at` text NOT NULL,
	PRIMARY KEY(`campaign_id`, `person_hash`)
);--> statement-breakpoint
INSERT INTO `__new_van_person_contacts` (`campaign_id`, `person_hash`, `last_in_person_at`)
SELECT 1, `person_hash`, `last_in_person_at` FROM `van_person_contacts`;--> statement-breakpoint
DROP TABLE `van_person_contacts`;--> statement-breakpoint
ALTER TABLE `__new_van_person_contacts` RENAME TO `van_person_contacts`;--> statement-breakpoint
CREATE TABLE `__new_van_sync_state` (
	`campaign_id` integer PRIMARY KEY NOT NULL,
	`last_sync_at` text,
	`minivan_exports_ok` integer,
	`last_error` text,
	`alerted_error` text
);--> statement-breakpoint
INSERT INTO `__new_van_sync_state` (`campaign_id`, `last_sync_at`, `minivan_exports_ok`)
SELECT `id`, `last_sync_at`, `minivan_exports_ok` FROM `van_sync_state`;--> statement-breakpoint
DROP TABLE `van_sync_state`;--> statement-breakpoint
ALTER TABLE `__new_van_sync_state` RENAME TO `van_sync_state`;--> statement-breakpoint
CREATE TABLE `__new_van_contact_sync_state` (
	`campaign_id` integer PRIMARY KEY NOT NULL,
	`cursor` text,
	`covered_from` text,
	`export_job_id` integer,
	`export_job_created_at` text,
	`export_job_failures` integer DEFAULT 0 NOT NULL,
	`window_from` text,
	`window_to` text,
	`last_run_at` text,
	`last_error` text,
	`counted_through` text,
	`full_recompute_at` text
);--> statement-breakpoint
INSERT INTO `__new_van_contact_sync_state` (`campaign_id`, `cursor`, `covered_from`, `export_job_id`, `export_job_created_at`, `export_job_failures`, `window_from`, `window_to`, `last_run_at`, `last_error`, `counted_through`, `full_recompute_at`)
SELECT `id`, `cursor`, `covered_from`, `export_job_id`, `export_job_created_at`, `export_job_failures`, `window_from`, `window_to`, `last_run_at`, `last_error`, `counted_through`, `full_recompute_at` FROM `van_contact_sync_state`;--> statement-breakpoint
DROP TABLE `van_contact_sync_state`;--> statement-breakpoint
ALTER TABLE `__new_van_contact_sync_state` RENAME TO `van_contact_sync_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

CREATE TABLE `van_contact_sync_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`cursor` text,
	`export_job_id` integer,
	`window_from` text,
	`window_to` text,
	`last_run_at` text,
	`last_error` text,
	CONSTRAINT "van_contact_sync_state_singleton" CHECK("van_contact_sync_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `van_person_contacts` (
	`person_hash` blob PRIMARY KEY NOT NULL,
	`last_in_person_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `van_turf_roster` (
	`map_route_id` integer NOT NULL,
	`person_hash` blob NOT NULL,
	`door_hash` blob NOT NULL,
	PRIMARY KEY(`map_route_id`, `person_hash`)
);
--> statement-breakpoint
ALTER TABLE `van_turfs` ADD `cut_at` text;--> statement-breakpoint
ALTER TABLE `van_turfs` ADD `uncontacted_doors` integer;--> statement-breakpoint
ALTER TABLE `van_turfs` ADD `uncontacted_doors_at` text;--> statement-breakpoint
ALTER TABLE `van_turfs` ADD `roster_saved_list_id` integer;
ALTER TABLE `van_contact_sync_state` ADD `counted_through` text;--> statement-breakpoint
ALTER TABLE `van_contact_sync_state` ADD `full_recompute_at` text;--> statement-breakpoint
CREATE INDEX `van_turf_roster_person` ON `van_turf_roster` (`person_hash`);
ALTER TABLE `van_contact_sync_state` ADD `covered_from` text;--> statement-breakpoint
ALTER TABLE `van_contact_sync_state` ADD `export_job_created_at` text;--> statement-breakpoint
ALTER TABLE `van_contact_sync_state` ADD `export_job_failures` integer DEFAULT 0 NOT NULL;
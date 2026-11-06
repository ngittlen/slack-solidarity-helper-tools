ALTER TABLE `van_turfs` ADD `van_released_at` text;--> statement-breakpoint
ALTER TABLE `van_turfs` ADD `van_released_by` text;--> statement-breakpoint
CREATE INDEX `van_turfs_van_held` ON `van_turfs` (`van_distributed_to`) WHERE "van_turfs"."van_distributed_to" IS NOT NULL;
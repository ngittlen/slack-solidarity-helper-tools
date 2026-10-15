CREATE TABLE `push_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`current_user_id` text,
	`created_at` text NOT NULL,
	`last_sent_at` text,
	`failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_endpoint_unique` ON `push_devices` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_devices_current_user` ON `push_devices` (`current_user_id`);--> statement-breakpoint
CREATE TABLE `push_opt_ins` (
	`device_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`device_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `push_opt_ins_user` ON `push_opt_ins` (`user_id`);--> statement-breakpoint
ALTER TABLE `van_turf_checkouts` ADD `doors_counted_notified_at` text;--> statement-breakpoint
ALTER TABLE `van_turf_checkouts` ADD `lapse_notified_at` text;--> statement-breakpoint
-- Claims that were counted or lapsed before these notices existed were never
-- going to be told; without this the first sync after deploy would push every
-- one still inside its window.
UPDATE `van_turf_checkouts` SET `doors_counted_notified_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `doors_knocked` > 0;--> statement-breakpoint
UPDATE `van_turf_checkouts` SET `lapse_notified_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `release_reason` = 'expired';

CREATE TABLE `van_campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`credential_key` text NOT NULL,
	`label` text,
	`enabled` integer DEFAULT false NOT NULL,
	`export_job_type_id` integer,
	`disabled_at` text,
	`disabled_by_name` text,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `van_campaigns_credential_key_unique` ON `van_campaigns` (`credential_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `van_campaigns_label_unique` ON `van_campaigns` (`label`);--> statement-breakpoint
-- The campaign the app has always served. Its credentials are the legacy
-- VAN_APP_NAME/VAN_API_KEY vars (or VAN_CAMPAIGN_PRIMARY), so it is enabled
-- from the start: nothing about an existing install changes. No label — an
-- admin names it in /settings.
INSERT INTO `van_campaigns` (`id`, `credential_key`, `enabled`, `last_edited_by`, `last_edited_by_name`, `last_edited_at`)
VALUES (1, 'primary', 1, 'migration', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

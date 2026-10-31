-- Per-campaign settings (specs/012-multi-van-campaigns/spec.md, Phases 4–5).
--
-- The region-refresh switch and the Packet Tracker tab name move from
-- app_config, where they were one setting for everyone, onto each campaign.
-- Campaign 1 — the one the app has always served — keeps exactly what it had:
-- the same refresh switch, the same tab, and sheets on, since its spreadsheet
-- rules are what already exist. Every other campaign starts with refresh and
-- sheets off: a re-cut deletes a campaign's printed lists, and most campaigns
-- keep no Packet Tracker, so both have to be asked for.
--
-- The spreadsheet rules gain the campaign in their key, and all existing rules
-- become campaign 1's.
ALTER TABLE `van_campaigns` ADD `refresh_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `van_campaigns` ADD `sheets_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `van_campaigns` ADD `sheet_tab_name` text;--> statement-breakpoint
UPDATE `van_campaigns` SET
	`refresh_enabled` = coalesce((SELECT `van_region_refresh_enabled` FROM `app_config` WHERE `id` = 1), 0),
	`sheets_enabled` = 1,
	`sheet_tab_name` = (SELECT `van_sheet_tab_name` FROM `app_config` WHERE `id` = 1)
WHERE `id` = 1;--> statement-breakpoint
ALTER TABLE `app_config` DROP COLUMN `van_region_refresh_enabled`;--> statement-breakpoint
ALTER TABLE `app_config` DROP COLUMN `van_sheet_tab_name`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_van_sheet_targets` (
	`campaign_id` integer DEFAULT 1 NOT NULL,
	`prefix_key` text NOT NULL,
	`prefix` text NOT NULL,
	`label` text NOT NULL,
	`spreadsheet_id` text NOT NULL,
	`last_edited_by` text NOT NULL,
	`last_edited_by_name` text NOT NULL,
	`last_edited_at` text NOT NULL,
	PRIMARY KEY(`campaign_id`, `prefix_key`)
);--> statement-breakpoint
INSERT INTO `__new_van_sheet_targets` (`campaign_id`, `prefix_key`, `prefix`, `label`, `spreadsheet_id`, `last_edited_by`, `last_edited_by_name`, `last_edited_at`)
SELECT 1, `prefix_key`, `prefix`, `label`, `spreadsheet_id`, `last_edited_by`, `last_edited_by_name`, `last_edited_at` FROM `van_sheet_targets`;--> statement-breakpoint
DROP TABLE `van_sheet_targets`;--> statement-breakpoint
ALTER TABLE `__new_van_sheet_targets` RENAME TO `van_sheet_targets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
-- Campaign names are unique ignoring case: "One Team Michigan" and "one team
-- michigan" would read as the same campaign on a turf badge. Rebuilt on
-- lower(label), which existing installs satisfy unless two names differ only
-- by case — in which case this fails loudly rather than keeping both.
DROP INDEX `van_campaigns_label_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `van_campaigns_label_unique` ON `van_campaigns` (lower("label"));

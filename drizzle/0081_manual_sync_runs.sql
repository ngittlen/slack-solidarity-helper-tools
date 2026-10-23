CREATE TABLE `van_manual_sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`started_by_name` text,
	`phase` text NOT NULL,
	`passes` integer DEFAULT 0 NOT NULL,
	`finished_at` text,
	`report` text,
	`requested_turf_ids` text
);

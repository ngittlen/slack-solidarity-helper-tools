CREATE TABLE `van_sync_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_sync_at` text NOT NULL,
	`minivan_exports_ok` integer,
	CONSTRAINT "van_sync_state_singleton" CHECK("van_sync_state"."id" = 1)
);
